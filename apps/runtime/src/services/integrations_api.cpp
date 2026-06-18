#include "omega/runtime/services/integrations_api.hpp"

#include <chrono>
#include <cstdlib>
#include <httplib.h>
#include <regex>
#include <stdexcept>

using json = nlohmann::json;

namespace omega::runtime {

namespace {

std::string env_token(const char* name) {
  if (const char* v = std::getenv(name)) {
    if (*v) return v;
  }
  return {};
}

}  // namespace

GitHubClient::GitHubClient(IntegrationsStore& integrations) : integrations_(integrations) {}

std::string GitHubClient::token() const {
  const json cfg = integrations_.load();
  if (cfg.contains("github") && cfg["github"].is_object()) {
    const std::string t = cfg["github"].value("token", "");
    if (!t.empty()) return t;
  }
  const std::string gh = env_token("GITHUB_TOKEN");
  if (!gh.empty()) return gh;
  return env_token("GH_TOKEN");
}

std::optional<std::tuple<std::string, std::string, int>> GitHubClient::parse_pr_url(
    const std::string& url) {
  static const std::regex re(R"(github\.com/([^/]+)/([^/]+)/pull/(\d+))", std::regex::icase);
  std::smatch m;
  if (!std::regex_search(url, m, re)) return std::nullopt;
  return std::make_tuple(m[1].str(), m[2].str(), std::stoi(m[3].str()));
}

json GitHubClient::fetch_pr(const std::string& owner, const std::string& repo, int number) {
  httplib::Headers h{{"Accept", "application/vnd.github+json"},
                       {"X-GitHub-Api-Version", "2022-11-28"}};
  const std::string tok = token();
  if (!tok.empty()) h.emplace("Authorization", "Bearer " + tok);

  httplib::Client cli("https://api.github.com");
  cli.set_connection_timeout(20, 0);
  cli.set_read_timeout(60, 0);

  const std::string base = "/repos/" + owner + "/" + repo;
  const auto pr_res = cli.Get((base + "/pulls/" + std::to_string(number)).c_str(), h);
  if (!pr_res || pr_res->status < 200 || pr_res->status >= 300) {
    throw std::runtime_error("GitHub PR fetch failed: HTTP " +
                             std::to_string(pr_res ? pr_res->status : 0));
  }
  const json pr = json::parse(pr_res->body);

  const auto files_res =
      cli.Get((base + "/pulls/" + std::to_string(number) + "/files?per_page=100").c_str(), h);
  json files = json::array();
  if (files_res && files_res->status >= 200 && files_res->status < 300) {
    const json raw = json::parse(files_res->body);
    if (raw.is_array()) {
      for (const auto& f : raw) {
        std::string status = f.value("status", "modified");
        if (status != "added" && status != "removed" && status != "renamed") status = "modified";
        files.push_back(json{{"path", f.value("filename", "")},
                             {"status", status},
                             {"additions", f.value("additions", 0)},
                             {"deletions", f.value("deletions", 0)},
                             {"patch", f.value("patch", "")}});
      }
    }
  }

  const int64_t now = std::chrono::duration_cast<std::chrono::milliseconds>(
                          std::chrono::system_clock::now().time_since_epoch())
                          .count();

  return json{{"owner", owner},
              {"repo", repo},
              {"number", number},
              {"title", pr.value("title", "")},
              {"state", pr.value("state", "")},
              {"author", pr.contains("user") ? pr["user"].value("login", "unknown") : "unknown"},
              {"body", pr.value("body", "")},
              {"files", files},
              {"fetchedAt", now}};
}

json GitHubClient::fetch_pr_from_url(const std::string& url) {
  const auto parsed = parse_pr_url(url);
  if (!parsed) throw std::runtime_error("Not a GitHub pull request URL");
  const auto& [owner, repo, number] = *parsed;
  return fetch_pr(owner, repo, number);
}

void GitHubClient::post_comment(const std::string& owner, const std::string& repo, int number,
                                const std::string& body) {
  httplib::Headers h{{"Accept", "application/vnd.github+json"},
                       {"Content-Type", "application/json"},
                       {"X-GitHub-Api-Version", "2022-11-28"}};
  const std::string tok = token();
  if (!tok.empty()) h.emplace("Authorization", "Bearer " + tok);

  httplib::Client cli("https://api.github.com");
  const auto res = cli.Post(("/repos/" + owner + "/" + repo + "/issues/" + std::to_string(number) +
                             "/comments")
                                .c_str(),
                            h, json{{"body", body}}.dump(), "application/json");
  if (!res || res->status < 200 || res->status >= 300) {
    throw std::runtime_error("GitHub comment failed: HTTP " + std::to_string(res ? res->status : 0));
  }
}

void GitHubClient::post_review(const std::string& owner, const std::string& repo, int number,
                               const std::string& event, const std::string& body) {
  httplib::Headers h{{"Accept", "application/vnd.github+json"},
                       {"Content-Type", "application/json"},
                       {"X-GitHub-Api-Version", "2022-11-28"}};
  const std::string tok = token();
  if (!tok.empty()) h.emplace("Authorization", "Bearer " + tok);

  httplib::Client cli("https://api.github.com");
  const auto pr_res =
      cli.Get(("/repos/" + owner + "/" + repo + "/pulls/" + std::to_string(number)).c_str(), h);
  if (!pr_res || pr_res->status < 200 || pr_res->status >= 300) {
    throw std::runtime_error("GitHub PR head fetch failed");
  }
  const json pr = json::parse(pr_res->body);
  const std::string commit_id =
      pr.contains("head") ? pr["head"].value("sha", "") : "";
  if (commit_id.empty()) throw std::runtime_error("Could not resolve PR head commit");

  const auto res = cli.Post(
      ("/repos/" + owner + "/" + repo + "/pulls/" + std::to_string(number) + "/reviews").c_str(), h,
      json{{"commit_id", commit_id}, {"body", body}, {"event", event}}.dump(), "application/json");
  if (!res || res->status < 200 || res->status >= 300) {
    throw std::runtime_error("GitHub review failed: HTTP " + std::to_string(res ? res->status : 0));
  }
}

JiraClient::JiraClient(IntegrationsStore& integrations) : integrations_(integrations) {}

std::string JiraClient::parse_issue_key(const std::string& input) {
  const std::string trimmed = input;
  static const std::regex url_re(R"(/browse/([A-Z][A-Z0-9]+-\d+))", std::regex::icase);
  std::smatch m;
  if (std::regex_search(trimmed, m, url_re)) {
    std::string key = m[1].str();
    for (auto& c : key) c = static_cast<char>(std::toupper(static_cast<unsigned char>(c)));
    return key;
  }
  static const std::regex key_re(R"(^[A-Z][A-Z0-9]+-\d+$)", std::regex::icase);
  if (std::regex_match(trimmed, key_re)) {
    std::string key = trimmed;
    for (auto& c : key) c = static_cast<char>(std::toupper(static_cast<unsigned char>(c)));
    return key;
  }
  return {};
}

json JiraClient::fetch_issue(const std::string& issue_key) {
  const json cfg = integrations_.load();
  if (!cfg.contains("jira") || !cfg["jira"].is_object()) {
    throw std::runtime_error("Jira not configured — set credentials in Settings → Integrations");
  }
  const json j = cfg["jira"];
  std::string base = j.value("baseUrl", "");
  while (!base.empty() && (base.back() == '/')) base.pop_back();
  const std::string email = j.value("email", "");
  const std::string api_token = j.value("apiToken", "");
  if (base.empty() || email.empty() || api_token.empty()) {
    throw std::runtime_error("Jira not configured — set base URL, email, and API token");
  }

  const std::string key = parse_issue_key(issue_key);
  if (key.empty()) throw std::runtime_error("Invalid Jira issue key or URL");

  const std::string creds = email + ":" + api_token;
  const std::string b64 = httplib::detail::base64_encode(creds);

  httplib::Headers h{{"Accept", "application/json"}, {"Authorization", "Basic " + b64}};

  httplib::Client cli(base);
  cli.set_connection_timeout(20, 0);
  cli.set_read_timeout(60, 0);

  const auto issue_res =
      cli.Get(("/rest/api/3/issue/" + key +
               "?fields=summary,status,assignee,reporter,description,priority,issuetype")
                  .c_str(),
              h);
  if (!issue_res || issue_res->status < 200 || issue_res->status >= 300) {
    throw std::runtime_error("Jira issue fetch failed: HTTP " +
                             std::to_string(issue_res ? issue_res->status : 0));
  }
  const json issue = json::parse(issue_res->body);
  const json fields = issue.value("fields", json::object());

  json comments = json::array();
  const auto comments_res =
      cli.Get(("/rest/api/3/issue/" + key + "/comment?maxResults=20").c_str(), h);
  if (comments_res && comments_res->status >= 200 && comments_res->status < 300) {
    const json cr = json::parse(comments_res->body);
    if (cr.contains("comments") && cr["comments"].is_array()) {
      for (const auto& c : cr["comments"]) {
        comments.push_back(json{{"author", c.contains("author") ? c["author"].value("displayName", "")
                                                               : ""},
                                {"body", c.value("body", json::object())},
                                {"created", c.value("created", "")}});
      }
    }
  }

  return json{{"key", key},
              {"summary", fields.value("summary", "")},
              {"status", fields.contains("status") ? fields["status"].value("name", "") : ""},
              {"assignee", fields.contains("assignee") && fields["assignee"].is_object()
                               ? fields["assignee"].value("displayName", "")
                               : ""},
              {"reporter", fields.contains("reporter") && fields["reporter"].is_object()
                               ? fields["reporter"].value("displayName", "")
                               : ""},
              {"priority", fields.contains("priority") && fields["priority"].is_object()
                               ? fields["priority"].value("name", "")
                               : ""},
              {"issueType", fields.contains("issuetype") && fields["issuetype"].is_object()
                                ? fields["issuetype"].value("name", "")
                                : ""},
              {"url", base + "/browse/" + key},
              {"comments", comments},
              {"fetchedAt", std::chrono::duration_cast<std::chrono::milliseconds>(
                                std::chrono::system_clock::now().time_since_epoch())
                                .count()}};
}

json JiraClient::fetch_from_url_or_key(const std::string& input) {
  return fetch_issue(parse_issue_key(input).empty() ? input : parse_issue_key(input));
}

void JiraClient::post_comment(const std::string& issue_key, const std::string& text) {
  const json cfg = integrations_.load();
  const json j = cfg.value("jira", json::object());
  std::string base = j.value("baseUrl", "");
  while (!base.empty() && (base.back() == '/')) base.pop_back();
  const std::string email = j.value("email", "");
  const std::string api_token = j.value("apiToken", "");
  if (base.empty() || email.empty() || api_token.empty()) {
    throw std::runtime_error("Jira not configured");
  }
  const std::string key = parse_issue_key(issue_key);
  if (key.empty()) throw std::runtime_error("Invalid Jira issue key");

  const std::string creds = email + ":" + api_token;
  const std::string b64 = httplib::detail::base64_encode(creds);
  httplib::Headers h{{"Accept", "application/json"},
                     {"Content-Type", "application/json"},
                     {"Authorization", "Basic " + b64}};

  httplib::Client cli(base);
  const json body{{"body",
                   json{{"type", "doc"},
                        {"version", 1},
                        {"content", json::array({json{{"type", "paragraph"},
                                                     {"content", json::array({json{{"type", "text"},
                                                                                {"text", text}}})}}})}}}};
  const auto res = cli.Post(("/rest/api/3/issue/" + key + "/comment").c_str(), h, body.dump(),
                            "application/json");
  if (!res || res->status < 200 || res->status >= 300) {
    throw std::runtime_error("Jira comment failed: HTTP " + std::to_string(res ? res->status : 0));
  }
}

}  // namespace omega::runtime
