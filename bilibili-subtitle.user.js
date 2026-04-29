// ==UserScript==
// @name         Bilibili Video Text for AI (Gemini)
// @namespace    https://www.bilibili.com/
// @version      0.2.0
// @description  Automatically extract Bilibili subtitles and inject them as visually hidden text for Chrome Gemini side panel to read.
// @match        https://www.bilibili.com/video/*
// @run-at       document-idle
// @grant        GM_xmlhttpRequest
// @connect      api.bilibili.com
// @connect      hdslb.com
// @connect      *.hdslb.com
// ==/UserScript==

(function () {
  "use strict";

  const IDS = {
    geminiArea: "bvt-gemini-transcript",
  };

  const MIXIN_KEY_ENC_TAB = [
    46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35,
    27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13,
    37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4,
    22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34, 44, 52,
  ];

  let currentVidKey = "";

  async function ensureSubtitlesInjected() {
    const bvid = getBvidFromUrl();
    if (!bvid) return;
    const pageIndex = getPageIndexFromUrl();
    const vidKey = `${bvid}-${pageIndex}`;

    if (currentVidKey === vidKey) return;
    currentVidKey = vidKey; // 标记已开始处理，防止重复请求

    try {
      const view = await getViewInfo(bvid);
      const pages = Array.isArray(view.pages) ? view.pages : [];
      const page = pages[pageIndex];
      if (!page || !page.cid) return;

      const meta = {
        aid: view.aid,
        bvid,
        title: view.title || document.title.replace(/_哔哩哔哩_bilibili$/, ""),
        pageTitle: page.part || `P${pageIndex + 1}`,
        pageNumber: page.page || pageIndex + 1,
        cid: page.cid,
      };

      const subtitleInfo = await getSubtitleInfo(meta);
      const entries = normalizeSubtitleEntries(subtitleInfo);
      if (entries.length === 0) return;

      const chosenIndex = chooseSubtitleIndex(entries);
      const entry = entries[chosenIndex] || entries[0];

      const subtitleData = await getSubtitleJson(entry.subtitle_url || entry.url);
      const body = Array.isArray(subtitleData.body) ? subtitleData.body : null;
      if (!body) return;

      const text = buildAiText(meta, body);
      injectDetailsText(text);
      console.log(`[BVT] 已成功注入折叠字幕供 Gemini 读取 (${body.length} 条)`);
    } catch (error) {
      console.error("[BVT] 自动获取字幕失败:", error);
      currentVidKey = ""; // 允许在失败后重试
    }
  }

  function injectDetailsText(text) {
    let container = document.getElementById(IDS.geminiArea);
    if (!container) {
      container = document.createElement("details");
      container.id = IDS.geminiArea;
      container.style.cssText = "margin: 12px 0; padding: 10px 14px; background: #f1f2f3; border-radius: 6px; font-size: 13px; color: #61666d; border: 1px solid #e3e5e7;";
      
      const summary = document.createElement("summary");
      summary.style.cssText = "cursor: pointer; outline: none; font-weight: 600; user-select: none;";
      summary.textContent = "🤖 AI 视频完整字幕文本 (供侧边栏读取，点击可展开查看)";
      
      const content = document.createElement("div");
      content.id = `${IDS.geminiArea}-content`;
      content.style.cssText = "margin-top: 10px; white-space: pre-wrap; max-height: 300px; overflow-y: auto; user-select: text; font-family: monospace; color: #18191c;";
      
      container.appendChild(summary);
      container.appendChild(content);

      const host = findHostElement();
      if (host.before) {
        host.parent.insertBefore(container, host.before);
      } else {
        document.body.appendChild(container);
      }
    }
    
    const contentNode = document.getElementById(`${IDS.geminiArea}-content`);
    if (contentNode) {
      contentNode.textContent = "==== 视频完整字幕文本（供AI总结使用） ====\n\n" + text;
    }
  }

  function findHostElement() {
    const selectors = [
      ".video-desc-container", // 新版 B 站简介区域
      "#v_desc",               // 老版 B 站简介区域
      ".left-container .video-desc-v1"
    ];
    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (el && el.parentNode) {
        return { parent: el.parentNode, before: el };
      }
    }
    return { parent: document.body, before: null };
  }

  function getBvidFromUrl() {
    const match = location.pathname.match(/\/video\/(BV[a-zA-Z0-9]{10})/);
    return match ? match[1] : "";
  }

  function getPageIndexFromUrl() {
    const p = Number(new URLSearchParams(location.search).get("p") || "1");
    if (!Number.isFinite(p) || p < 1) return 0;
    return Math.floor(p) - 1;
  }

  async function getViewInfo(bvid) {
    const url = `https://api.bilibili.com/x/web-interface/view?bvid=${encodeURIComponent(bvid)}`;
    const json = await requestJson(url);
    assertApiOk(json, "视频信息接口失败");
    if (!json.data) throw new Error("视频信息接口未返回 data。");
    return json.data;
  }

  async function getSubtitleInfo(meta) {
    const keys = await getWbiKeys();
    const params = signWbi(
      {
        aid: meta.aid,
        bvid: meta.bvid,
        cid: meta.cid,
        isGaiaAvoided: false,
        web_location: 1315873,
      },
      keys
    );
    const url = `https://api.bilibili.com/x/player/wbi/v2?${toQuery(params)}`;
    const json = await requestJson(url);
    assertApiOk(json, "字幕信息接口失败");
    if (!json.data) throw new Error("字幕信息接口未返回 data。");
    return json.data.subtitle;
  }

  async function getWbiKeys() {
    const json = await requestJson("https://api.bilibili.com/x/web-interface/nav");
    if (!json || !json.data || !json.data.wbi_img) {
      throw new Error("未获取到 WBI key。");
    }
    const imgKey = extractWbiKey(json.data.wbi_img.img_url);
    const subKey = extractWbiKey(json.data.wbi_img.sub_url);
    if (!imgKey || !subKey) throw new Error("WBI key 格式无效。");
    return { imgKey, subKey };
  }

  function extractWbiKey(url) {
    if (!url) return "";
    const filename = String(url).split("/").pop() || "";
    return filename.split(".")[0] || "";
  }

  function normalizeSubtitleEntries(subtitle) {
    if (!subtitle) return [];
    const entries = subtitle.subtitles || subtitle.list || [];
    if (!Array.isArray(entries)) return [];
    return entries.filter((entry) => entry && (entry.subtitle_url || entry.url));
  }

  function chooseSubtitleIndex(entries) {
    const preferred = entries.findIndex((entry) => {
      const lan = `${entry.lan || ""} ${entry.lan_doc || ""}`.toLowerCase();
      return lan.includes("zh") || lan.includes("中文");
    });
    return preferred >= 0 ? preferred : 0;
  }

  async function getSubtitleJson(url) {
    const normalizedUrl = normalizeSubtitleUrl(url);
    if (!normalizedUrl) throw new Error("字幕链接为空。");
    const json = await requestJson(normalizedUrl);
    if (!json || typeof json !== "object") throw new Error("字幕 JSON 解析失败。");
    return json;
  }

  function normalizeSubtitleUrl(url) {
    if (!url) return "";
    const value = String(url);
    if (value.startsWith("//")) return `https:${value}`;
    if (value.startsWith("http://")) return value.replace(/^http:\/\//, "https://");
    return value;
  }

  function buildAiText(meta, body) {
    const contents = body
      .map((item) => normalizeContent(item && item.content))
      .filter(Boolean);

    const paragraphs = splitIntoParagraphs(contents);
    const header = [
      `标题：${meta.title}`,
      `BV：${meta.bvid}`,
      `分P：P${meta.pageNumber} ${meta.pageTitle}`.trim(),
      "",
    ];
    return `${header.join("\n")}${paragraphs.join("\n\n")}`.trim();
  }

  function normalizeContent(value) {
    return String(value || "")
      .replace(/\s+/g, " ")
      .replace(/\s*([，。！？；：、,.!?;:])\s*/g, "$1")
      .trim();
  }

  function splitIntoParagraphs(lines) {
    const paragraphs = [];
    let buffer = "";
    let sentenceCount = 0;

    for (const line of lines) {
      if (!buffer) {
        buffer = line;
      } else if (/^[A-Za-z0-9]/.test(line) && /[A-Za-z0-9]$/.test(buffer)) {
        buffer += " " + line;
      } else {
        buffer += line;
      }

      sentenceCount += countSentenceEnds(line);
      if (sentenceCount >= 5 || buffer.length >= 520) {
        paragraphs.push(buffer.trim());
        buffer = "";
        sentenceCount = 0;
      }
    }

    if (buffer.trim()) paragraphs.push(buffer.trim());
    return paragraphs;
  }

  function countSentenceEnds(text) {
    const matches = String(text).match(/[。！？.!?]/g);
    return matches ? matches.length : 0;
  }

  function assertApiOk(json, fallback) {
    if (!json || typeof json.code !== "number") {
      throw new Error(`${fallback}：响应格式无效。`);
    }
    if (json.code !== 0) {
      throw new Error(`${fallback}：${json.message || json.msg || json.code}`);
    }
  }

  function signWbi(params, keys) {
    const mixinKey = getMixinKey(keys.imgKey + keys.subKey);
    const signed = Object.assign({}, params, {
      wts: Math.floor(Date.now() / 1000),
    });
    const sorted = {};
    Object.keys(signed)
      .sort()
      .forEach((key) => {
        sorted[key] = String(signed[key]).replace(/[!'()*]/g, "");
      });
    const query = toQuery(sorted);
    signed.w_rid = md5(query + mixinKey);
    return signed;
  }

  function getMixinKey(rawKey) {
    return MIXIN_KEY_ENC_TAB.map((index) => rawKey[index]).join("").slice(0, 32);
  }

  function toQuery(params) {
    return Object.keys(params)
      .map((key) => `${encodeURIComponent(key)}=${encodeURIComponent(params[key])}`)
      .join("&");
  }

  function requestJson(url) {
    return new Promise((resolve, reject) => {
      if (typeof GM_xmlhttpRequest === "function") {
        GM_xmlhttpRequest({
          method: "GET",
          url,
          headers: {
            "Accept": "application/json, text/plain, */*",
            "Referer": "https://www.bilibili.com/",
          },
          withCredentials: true,
          onload(response) {
            try {
              resolve(JSON.parse(response.responseText));
            } catch (error) {
              reject(new Error("JSON 解析失败。"));
            }
          },
          onerror() {
            reject(new Error("网络请求失败。"));
          },
          ontimeout() {
            reject(new Error("网络请求超时。"));
          },
          timeout: 20000,
        });
        return;
      }

      fetch(url, {
        credentials: "include",
        headers: {
          "Accept": "application/json, text/plain, */*",
        },
      })
        .then((response) => response.text())
        .then((text) => resolve(JSON.parse(text)))
        .catch(() => reject(new Error("网络请求失败。")));
    });
  }

  function md5(input) {
    function add32(a, b) { return (a + b) & 0xffffffff; }
    function cmn(q, a, b, x, s, t) {
      a = add32(add32(a, q), add32(x, t));
      return add32((a << s) | (a >>> (32 - s)), b);
    }
    function ff(a, b, c, d, x, s, t) { return cmn((b & c) | (~b & d), a, b, x, s, t); }
    function gg(a, b, c, d, x, s, t) { return cmn((b & d) | (c & ~d), a, b, x, s, t); }
    function hh(a, b, c, d, x, s, t) { return cmn(b ^ c ^ d, a, b, x, s, t); }
    function ii(a, b, c, d, x, s, t) { return cmn(c ^ (b | ~d), a, b, x, s, t); }
    function md5cycle(state, block) {
      let a = state[0], b = state[1], c = state[2], d = state[3];

      a = ff(a, b, c, d, block[0], 7, -680876936); d = ff(d, a, b, c, block[1], 12, -389564586); c = ff(c, d, a, b, block[2], 17, 606105819); b = ff(b, c, d, a, block[3], 22, -1044525330);
      a = ff(a, b, c, d, block[4], 7, -176418897); d = ff(d, a, b, c, block[5], 12, 1200080426); c = ff(c, d, a, b, block[6], 17, -1473231341); b = ff(b, c, d, a, block[7], 22, -45705983);
      a = ff(a, b, c, d, block[8], 7, 1770035416); d = ff(d, a, b, c, block[9], 12, -1958414417); c = ff(c, d, a, b, block[10], 17, -42063); b = ff(b, c, d, a, block[11], 22, -1990404162);
      a = ff(a, b, c, d, block[12], 7, 1804603682); d = ff(d, a, b, c, block[13], 12, -40341101); c = ff(c, d, a, b, block[14], 17, -1502002290); b = ff(b, c, d, a, block[15], 22, 1236535329);

      a = gg(a, b, c, d, block[1], 5, -165796510); d = gg(d, a, b, c, block[6], 9, -1069501632); c = gg(c, d, a, b, block[11], 14, 643717713); b = gg(b, c, d, a, block[0], 20, -373897302);
      a = gg(a, b, c, d, block[5], 5, -701558691); d = gg(d, a, b, c, block[10], 9, 38016083); c = gg(c, d, a, b, block[15], 14, -660478335); b = gg(b, c, d, a, block[4], 20, -405537848);
      a = gg(a, b, c, d, block[9], 5, 568446438); d = gg(d, a, b, c, block[14], 9, -1019803690); c = gg(c, d, a, b, block[3], 14, -187363961); b = gg(b, c, d, a, block[8], 20, 1163531501);
      a = gg(a, b, c, d, block[13], 5, -1444681467); d = gg(d, a, b, c, block[2], 9, -51403784); c = gg(c, d, a, b, block[7], 14, 1735328473); b = gg(b, c, d, a, block[12], 20, -1926607734);

      a = hh(a, b, c, d, block[5], 4, -378558); d = hh(d, a, b, c, block[8], 11, -2022574463); c = hh(c, d, a, b, block[11], 16, 1839030562); b = hh(b, c, d, a, block[14], 23, -35309556);
      a = hh(a, b, c, d, block[1], 4, -1530992060); d = hh(d, a, b, c, block[4], 11, 1272893353); c = hh(c, d, a, b, block[7], 16, -155497632); b = hh(b, c, d, a, block[10], 23, -1094730640);
      a = hh(a, b, c, d, block[13], 4, 681279174); d = hh(d, a, b, c, block[0], 11, -358537222); c = hh(c, d, a, b, block[3], 16, -722521979); b = hh(b, c, d, a, block[6], 23, 76029189);
      a = hh(a, b, c, d, block[9], 4, -640364487); d = hh(d, a, b, c, block[12], 11, -421815835); c = hh(c, d, a, b, block[15], 16, 530742520); b = hh(b, c, d, a, block[2], 23, -995338651);

      a = ii(a, b, c, d, block[0], 6, -198630844); d = ii(d, a, b, c, block[7], 10, 1126891415); c = ii(c, d, a, b, block[14], 15, -1416354905); b = ii(b, c, d, a, block[5], 21, -57434055);
      a = ii(a, b, c, d, block[12], 6, 1700485571); d = ii(d, a, b, c, block[3], 10, -1894986606); c = ii(c, d, a, b, block[10], 15, -1051523); b = ii(b, c, d, a, block[1], 21, -2054922799);
      a = ii(a, b, c, d, block[8], 6, 1873313359); d = ii(d, a, b, c, block[15], 10, -30611744); c = ii(c, d, a, b, block[6], 15, -1560198380); b = ii(b, c, d, a, block[13], 21, 1309151649);
      a = ii(a, b, c, d, block[4], 6, -145523070); d = ii(d, a, b, c, block[11], 10, -1120210379); c = ii(c, d, a, b, block[2], 15, 718787259); b = ii(b, c, d, a, block[9], 21, -343485551);

      state[0] = add32(a, state[0]); state[1] = add32(b, state[1]); state[2] = add32(c, state[2]); state[3] = add32(d, state[3]);
    }
    function md5blk(str) {
      const block = [];
      for (let i = 0; i < 64; i += 4) {
        block[i >> 2] = str.charCodeAt(i) + (str.charCodeAt(i + 1) << 8) + (str.charCodeAt(i + 2) << 16) + (str.charCodeAt(i + 3) << 24);
      }
      return block;
    }
    function md51(str) {
      const utf8 = unescape(encodeURIComponent(str));
      const length = utf8.length;
      const state = [1732584193, -271733879, -1732584194, 271733878];
      let i;
      for (i = 64; i <= length; i += 64) {
        md5cycle(state, md5blk(utf8.substring(i - 64, i)));
      }
      const tail = new Array(16).fill(0);
      const rest = utf8.substring(i - 64);
      for (i = 0; i < rest.length; i += 1) {
        tail[i >> 2] |= rest.charCodeAt(i) << ((i % 4) << 3);
      }
      tail[i >> 2] |= 0x80 << ((i % 4) << 3);
      if (i > 55) {
        md5cycle(state, tail);
        tail.fill(0);
      }
      tail[14] = length * 8;
      md5cycle(state, tail);
      return state;
    }
    function rhex(n) {
      const hex = "0123456789abcdef";
      let str = "";
      for (let j = 0; j < 4; j += 1) {
        str += hex[(n >> (j * 8 + 4)) & 0x0f] + hex[(n >> (j * 8)) & 0x0f];
      }
      return str;
    }
    return md51(input).map(rhex).join("");
  }

  // 初始检测并设置定时器以应对 B 站的单页路由切换
  ensureSubtitlesInjected();
  setInterval(ensureSubtitlesInjected, 2000);

})();
