// Transport details are not display text. Resolve language when showing a notice.
export function localizedError(message, language = "zh") {
  const en = language.toLowerCase().startsWith("en");
  const t = (zh, english) => en ? english : zh;
  if (/8 MB|413|too large/i.test(message)) return t("请选择不超过 8 MB 的非空文件", "Choose a non-empty file up to 8 MB");
  if (/已结束/.test(message)) return t("本次会话已结束，发送消息即可继续咨询。", "This conversation has ended. Send a message to continue.");
  if (/401|403|unauthorized|expired|失效/i.test(message)) return t("会话或授权已失效，请重新连接后重试", "Session or permission expired. Reconnect and try again.");
  if (/429|rate limit|频繁/i.test(message)) return t("请求过于频繁，请稍后重试", "Too many requests. Please try again shortly.");
  if (/network|fetch|load failed|timeout|网络/i.test(message)) return t("网络连接异常，请检查网络后重试", "Connection failed. Check your network and try again.");
  return t("操作未完成，请重试", "Operation failed. Please try again.");
}
