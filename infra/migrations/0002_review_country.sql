-- 评价带上「国家 / 地区」，界面据此渲染「来自德国的玩家」+ 一面 SVG 旗子。
--
-- 只存 Cloudflare 免费给的两字母国家码（request.cf.country），**不存 IP、不存城市级**：
-- IP 是可识别数据，落了库就要按 GDPR 那套处理（保留期、删除请求、泄露通报），
-- 而我们要的只是「哪个国家的玩家」这一点点信息。国家码本身不足以定位到人。
--
-- 取值规则见 infra/src/write.js 的 sanitizeCountry：只认 /^[A-Z]{2}$/，
-- 未知 / Tor（XX、T1）一律落空串，界面按「未知地区」渲染。
ALTER TABLE reviews ADD COLUMN country TEXT NOT NULL DEFAULT '';