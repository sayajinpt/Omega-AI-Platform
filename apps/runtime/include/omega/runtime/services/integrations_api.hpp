#pragma once

#include "omega/runtime/storage/integrations_store.hpp"

#include <nlohmann/json.hpp>
#include <optional>
#include <string>
#include <tuple>

namespace omega::runtime {

class GitHubClient {
 public:
  explicit GitHubClient(IntegrationsStore& integrations);

  static std::optional<std::tuple<std::string, std::string, int>> parse_pr_url(
      const std::string& url);
  nlohmann::json fetch_pr(const std::string& owner, const std::string& repo, int number);
  nlohmann::json fetch_pr_from_url(const std::string& url);
  void post_comment(const std::string& owner, const std::string& repo, int number,
                    const std::string& body);
  void post_review(const std::string& owner, const std::string& repo, int number,
                   const std::string& event, const std::string& body);

 private:
  std::string token() const;

  IntegrationsStore& integrations_;
};

class JiraClient {
 public:
  explicit JiraClient(IntegrationsStore& integrations);

  static std::string parse_issue_key(const std::string& input);
  nlohmann::json fetch_issue(const std::string& issue_key);
  nlohmann::json fetch_from_url_or_key(const std::string& input);
  void post_comment(const std::string& issue_key, const std::string& text);

 private:
  IntegrationsStore& integrations_;
};

}  // namespace omega::runtime
