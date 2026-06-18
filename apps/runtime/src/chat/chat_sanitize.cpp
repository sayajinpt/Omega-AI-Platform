#include "omega/runtime/chat/chat_sanitize.hpp"

#include <regex>

namespace omega::runtime {

namespace {

std::string regex_strip(std::string text, const std::regex& re) {
  return std::regex_replace(text, re, "");
}

std::string strip_invalid_utf8(std::string text) {
  std::string out;
  out.reserve(text.size());
  for (size_t i = 0; i < text.size();) {
    const unsigned char c = static_cast<unsigned char>(text[i]);
    if (c < 0x80) {
      if (c == '\n' || c == '\r' || c == '\t' || c >= 0x20) out.push_back(static_cast<char>(c));
      ++i;
      continue;
    }
    size_t need = 0;
    if ((c & 0xE0) == 0xC0) need = 2;
    else if ((c & 0xF0) == 0xE0) need = 3;
    else if ((c & 0xF8) == 0xF0) need = 4;
    else {
      ++i;
      continue;
    }
    if (i + need > text.size()) break;
    bool ok = true;
    for (size_t j = 1; j < need; ++j) {
      const unsigned char cc = static_cast<unsigned char>(text[i + j]);
      if ((cc & 0xC0) != 0x80) {
        ok = false;
        break;
      }
    }
    if (ok) {
      out.append(text, i, need);
      i += need;
    } else {
      ++i;
    }
  }
  return out;
}

std::string strip_template_markers(std::string text) {
  static const std::regex im_end(R"(<\|(?:redacted_)?im_end\|>)", std::regex_constants::icase);
  static const std::regex endoftext(R"(<\|endoftext\|>)", std::regex_constants::icase);
  static const std::regex end_tok(R"(<\|end\|>)", std::regex_constants::icase);
  static const std::regex assistant_tok(R"(<\|assistant\|>)", std::regex_constants::icase);
  static const std::regex user_tok(R"(<\|user\|>)", std::regex_constants::icase);
  static const std::regex trailing(R"(<\|[^\n>]*$)", std::regex_constants::icase);

  text = regex_strip(text, im_end);
  text = regex_strip(text, endoftext);
  text = regex_strip(text, end_tok);
  text = regex_strip(text, assistant_tok);
  text = regex_strip(text, user_tok);
  text = regex_strip(text, trailing);
  return text;
}

std::string strip_replacement_chars(std::string text) {
  std::string out;
  out.reserve(text.size());
  for (size_t i = 0; i < text.size();) {
    const unsigned char c = static_cast<unsigned char>(text[i]);
    if (c == 0xEF && i + 2 < text.size() &&
        static_cast<unsigned char>(text[i + 1]) == 0xBF &&
        static_cast<unsigned char>(text[i + 2]) == 0xBD) {
      i += 3;
      continue;
    }
    if (c == '\n' || c == '\r' || c == '\t' || c >= 0x20 || c >= 0x80) {
      out.push_back(static_cast<char>(c));
    }
    ++i;
  }
  return out;
}

}  // namespace

std::string sanitize_assistant_stream_text(std::string text) {
  text = strip_template_markers(std::move(text));
  text = strip_replacement_chars(std::move(text));
  while (!text.empty() && (text.back() == ' ' || text.back() == '\t')) text.pop_back();
  return text;
}

std::string sanitize_assistant_persist_text(std::string text) {
  text = sanitize_assistant_stream_text(std::move(text));
  return strip_invalid_utf8(std::move(text));
}

}  // namespace omega::runtime
