/**
 * 汉典 (zdic.net) Bob 词典插件
 *
 * 汉典没有公开 API，这里抓取 https://www.zdic.net/{hans|hant}/{词条} 页面并解析。
 * Bob 的 JS 环境没有 DOM，所以全部使用字符串 / 正则处理。
 *
 * https://bobtranslate.com/plugin/quickstart/translate.html
 */

// ---------------------------------------------------------------------------
// 基础定义
// ---------------------------------------------------------------------------

/**
 * 自定义错误类
 *
 * @param {'unknown'|'param'|'unsupportedLanguage'|'secretKey'|'network'|'api'|'notFound'} type 错误类型。
 * @param {string} message 错误信息。
 * @param {any=} addtion 附加信息。
 * @param {string=} troubleshootingLink 故障排除的链接。
 */
class KnownError extends Error {
  constructor(type, message, addtion, troubleshootingLink) {
    super(message);
    this.type = type;
    this.addtion = addtion;
    this.troubleshootingLink = troubleshootingLink;
  }
}

const BASE_URL = "https://zdic.net"; // www.zdic.net 会 301 到此域名
const MAX_QUERY_LENGTH = 30;
const CACHE_VERSION = "v8"; // 解析逻辑变更后递增，使旧缓存失效
const CACHE_TTL_MS = 7 * 24 * 3600 * 1000;
const LANGUAGES = ["auto", "zh-Hans", "zh-Hant"];

// 汉字（含扩展 A 与扩展 B~G 的代理对）
const HAN_RE = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]|[\ud840-\ud884][\udc00-\udfff]/;

/**
 * 返回支持的语言列表。
 *
 * @return {Array<string>} 支持的语言代码列表。
 */
function supportLanguages() {
  return LANGUAGES.slice();
}

/**
 * 设定返回超时时间
 *
 * @return {number} 超时时间，单位为秒。
 */
function pluginTimeoutInterval() {
  return 30;
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

/**
 * 主查询函数。
 *
 * @param {Object} query 查询对象。
 * @param {string} query.text 需要查询的文本。
 * @param {string} query.detectFrom 检测过后的源语言。
 * @param {string} query.detectTo 检测过后的目标语言。
 * @param {$signal} query.cancelSignal 取消信号。
 * @param {Function} query.onCompletion 处理响应的回调函数。
 * @return {void}
 */
function translate(query) {
  (async () => {
    try {
      const text = normalizeQuery(query.text);
      if (!text) {
        throw new KnownError("param", "查询内容为空");
      }
      if (/[\s\u00a0\u3000]/.test(text)) {
        throw new KnownError(
          "param",
          "汉典一次只能查询一个字、词语或成语",
          "请只选中一个词条后重试"
        );
      }
      if (!HAN_RE.test(text)) {
        throw new KnownError(
          "unsupportedLanguage",
          "汉典仅支持汉字词条",
          "请选中汉字、词语或成语后重试"
        );
      }
      if (Array.from(text).length > MAX_QUERY_LENGTH) {
        throw new KnownError(
          "param",
          "汉典仅支持查询单字、词语或成语",
          "请选中更短的文本后重试"
        );
      }

      const order = variantOrder();
      const cacheKey = makeCacheKey(text, order[0]);

      let entry = readCache(cacheKey);
      if (!entry) {
        entry = await lookup(text, order, query);
        writeCache(cacheKey, entry);
      }

      query.onCompletion({
        result: {
          from: query.detectFrom,
          to: query.detectTo,
          toParagraphs: [],
          toDict: entry.toDict,
        },
      });
    } catch (err) {
      handleError(err, query);
    }
  })();
}

/**
 * 依次尝试各个页面变体（简体 / 繁体），第一个有内容的就返回。
 * 仅在“未收录”时才尝试下一个，其他错误（网络、接口）直接抛出。
 */
async function lookup(text, order, query) {
  let lastNotFound = null;
  for (const variant of order) {
    const url = `${BASE_URL}/${variant}/${encodeURIComponent(text)}`;
    logInfo(`汉典请求 url: ${url}`);
    try {
      const html = await fetchPage(url, query);
      const entry = parseEntry(html, text, url);
      if (entry) return entry;
      lastNotFound = new KnownError("notFound", "汉典未收录该条目");
    } catch (err) {
      if (err && err.type === "notFound") lastNotFound = err;
      else throw err;
    }
  }
  throw lastNotFound || new KnownError("notFound", "汉典未收录该条目");
}

// ---------------------------------------------------------------------------
// 缓存 / 日志
// ---------------------------------------------------------------------------

function logInfo(msg) {
  if (typeof $log !== "undefined" && $log && $log.info) $log.info(msg);
}

function logError(msg) {
  if (typeof $log !== "undefined" && $log && $log.error) $log.error(msg);
}

function hasCache() {
  return (
    typeof $cache !== "undefined" &&
    $cache &&
    typeof $cache.get === "function" &&
    typeof $cache.set === "function"
  );
}

function makeCacheKey(text, variant) {
  return `zdic:${CACHE_VERSION}:${variant}:${text}`;
}

function readCache(key) {
  if (!hasCache()) return null;
  try {
    const raw = $cache.get(key);
    if (!raw) return null;
    const obj = JSON.parse(raw);
    if (!obj || !obj.data || Date.now() - obj.t > CACHE_TTL_MS) return null;
    return obj.data;
  } catch (e) {
    return null;
  }
}

function writeCache(key, data) {
  if (!hasCache()) return;
  try {
    $cache.set(key, JSON.stringify({ t: Date.now(), data: data }));
  } catch (e) {
    // 缓存失败不影响主流程
  }
}

// ---------------------------------------------------------------------------
// 请求相关
// ---------------------------------------------------------------------------

const PUNCT = "，。、；：？！“”‘’（）《》〈〉【】「」『』…—·,.;:?!\"'()\\[\\]<>";
const EDGE_RE = new RegExp(
  `^[\\s\\u00a0\\u3000${PUNCT}]+|[\\s\\u00a0\\u3000${PUNCT}]+$`,
  "g"
);

/**
 * 去掉首尾空白与常见标点（中间的空白保留，由调用方判断）。
 *
 * @param {string} text 原始文本。
 * @return {string} 处理后的查询词。
 */
function normalizeQuery(text) {
  return (text || "").replace(EDGE_RE, "");
}

/**
 * 页面尝试顺序：先简体 (hans)，“未收录”时回退繁体 (hant)。
 *
 * Bob 对单字的语言检测不可靠（如“点”常被判成繁体），而汉典简体页对繁体字同样有完整内容，
 * 所以总是先查简体页，查不到再回退繁体页。
 *
 * @return {Array<'hans'|'hant'>} 页面路径顺序。
 */
function variantOrder() {
  return ["hans", "hant"];
}

function isCancelled(error) {
  // NSURLErrorCancelled
  return !!error && Number(error.code) === -999;
}

/**
 * 请求汉典页面并返回 HTML 字符串。网络错误与 5xx 会重试一次。
 *
 * @param {string} url 页面地址。
 * @param {Object} query 查询对象（用于透传取消信号）。
 * @return {Promise<string>} 页面 HTML。
 */
async function fetchPage(url, query) {
  let lastErr = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    const resp = await $http.request({
      method: "GET",
      url,
      header: {
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15",
        Accept: "text/html,application/xhtml+xml",
        "Accept-Language": "zh-CN,zh;q=0.9",
      },
      timeout: 15,
      cancelSignal: query.cancelSignal,
    });

    if (resp.error) {
      if (isCancelled(resp.error)) {
        const e = new KnownError("unknown", "请求已取消");
        e.cancelled = true;
        throw e;
      }
      lastErr = new KnownError(
        "network",
        `请求汉典失败 - ${resp.error.localizedDescription || "未知错误"}`,
        resp.error.localizedFailureReason
      );
      continue;
    }

    const status = resp.response && resp.response.statusCode;
    if (status === 404) {
      throw new KnownError("notFound", "汉典未收录该条目");
    }
    if (status && status >= 500) {
      lastErr = new KnownError("api", `汉典返回异常状态码 ${status}`);
      continue;
    }
    if (status && status >= 400) {
      throw new KnownError("api", `汉典返回异常状态码 ${status}`);
    }

    let body = resp.data;
    if (typeof body !== "string" && resp.rawData && resp.rawData.toUTF8) {
      body = resp.rawData.toUTF8();
    }
    if (typeof body !== "string" || body.length === 0) {
      throw new KnownError("api", "汉典返回数据为空", "请检查网络连接或稍后重试");
    }
    return body;
  }
  throw lastErr;
}

// ---------------------------------------------------------------------------
// 通用文本工具
// ---------------------------------------------------------------------------

/**
 * 按“字符”（而不是 UTF-16 单元）截断，避免切坏生僻字。
 */
function truncate(s, n, suffix) {
  const arr = Array.from(s || "");
  if (arr.length <= n) return s || "";
  return arr.slice(0, n).join("").trim() + (suffix === undefined ? "…" : suffix);
}

// ---------------------------------------------------------------------------
// HTML 处理工具
// ---------------------------------------------------------------------------

const LINK_MARK = "\u0002"; // 标记 <a> 的起点，用于还原“词条链接列表”
const BLOCK_TAGS = {
  p: 1, div: 1, ul: 1, ol: 1, h1: 1, h2: 1, h3: 1, h4: 1, h5: 1, h6: 1,
  tr: 1, table: 1, section: 1, article: 1, header: 1, footer: 1, nav: 1,
  dl: 1, dt: 1, dd: 1, br: 1, hr: 1, blockquote: 1,
};

function safeFromCodePoint(n) {
  try {
    return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : "";
  } catch (e) {
    return "";
  }
}

function decodeEntities(s) {
  return s
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => safeFromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => safeFromCodePoint(parseInt(d, 10)))
    .replace(/&amp;/g, "&");
}

function stripTags(s) {
  return decodeEntities(s.replace(/<[^>]+>/g, ""));
}

/**
 * 把 HTML 片段转成“行”数组：
 * - 块级标签换行
 * - <ol><li> 输出 “1. ”、<ul><li> 输出 “• ”
 * - <a> 起点插入 LINK_MARK
 *
 * @param {string} html HTML 片段。
 * @return {Array<string>} 文本行（已去空行）。
 */
function htmlToLines(html) {
  const cleaned = html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<(script|style|noscript|svg)\b[\s\S]*?<\/\1>/gi, "");

  const tagRe = /<(\/?)([a-zA-Z][a-zA-Z0-9]*)\b[^>]*>/g;
  const stack = [];
  let out = "";
  let last = 0;
  let m;
  while ((m = tagRe.exec(cleaned))) {
    out += cleaned.slice(last, m.index);
    last = tagRe.lastIndex;
    const closing = m[1] === "/";
    const name = m[2].toLowerCase();

    if (name === "ol" || name === "ul") {
      if (closing) stack.pop();
      else stack.push({ type: name, n: 0 });
      out += "\n";
    } else if (name === "li") {
      if (closing) {
        out += "\n";
      } else {
        const top = stack[stack.length - 1];
        if (top && top.type === "ol") {
          top.n += 1;
          out += `\n${top.n}. `;
        } else {
          out += "\n• ";
        }
      }
    } else if (name === "a") {
      if (!closing) out += LINK_MARK;
    } else if (BLOCK_TAGS[name]) {
      out += "\n";
    }
  }
  out += cleaned.slice(last);

  return decodeEntities(out)
    .split("\n")
    .map((l) => l.replace(/[ \t\u00a0\u3000]+/g, " ").trim())
    .filter((l) => l && l !== "•");
}

/**
 * 清理单行文本中的链接标记。
 * “近义词/反义词”行以及链接列表（≥3 个链接）会用顿号串起来。
 */
function clean(raw) {
  if (raw.indexOf(LINK_MARK) === -1) return raw;
  const parts = raw
    .split(LINK_MARK)
    .map((s) => s.trim())
    .filter((s) => s && !/^显示更多|^顯示更多/.test(s));

  if (parts.length === 0) return "";

  if (/^(近义词|反义词|近義詞|反義詞)/.test(raw)) {
    return parts.length > 1 ? parts[0] + "：" + parts.slice(1).join("、") : parts[0];
  }
  const linkCount = raw.split(LINK_MARK).length - 1;
  if (linkCount >= 3) {
    const shown = parts.slice(0, 13);
    return shown.join("、") + (parts.length > shown.length ? "…" : "");
  }
  return raw.split(LINK_MARK).join("");
}

// ---------------------------------------------------------------------------
// 页面解析
// ---------------------------------------------------------------------------

// 分区标题（简体 / 繁体）→ 内部 key
const SECTION_MAP = {
  基本解释: "basic", 基本解釋: "basic",
  详细解释: "detail", 詳細解釋: "detail",
  词语解释: "word", 詞語解釋: "word",
  成语: "idiom", 成語: "idiom",
  国语辞典: "guoyu", 國語辭典: "guoyu",
  康熙字典: "kangxi",
  说文解字: "shuowen", 說文解字: "shuowen",
  近反义词: "syn", 近反義詞: "syn",
  翻译: "trans", 翻譯: "trans",
  // 不使用，但需要识别以正确截断上一个分区
  百科: "wiki",
  音韵方言: "phon", 音韻方言: "phon",
  字源字形: "glyph",
};
const SECTION_RE = new RegExp(
  "^(.*?)\\s*(" +
  Object.keys(SECTION_MAP)
    .sort((a, b) => b.length - a.length)
    .join("|") +
  ")$"
);

const LANG_LABEL_MAP = {
  英语: "英语", 英語: "英语",
  德语: "德语", 德語: "德语",
  法语: "法语", 法語: "法语",
  日语: "日语", 日語: "日语",
  俄语: "俄语", 俄語: "俄语",
};

/**
 * 按 <h1>-<h6> 标题把页面切成若干分区。
 *
 * @param {string} html 页面 HTML。
 * @return {Array<{key: string, start: number, html: string}>} 分区列表。
 */
function splitSections(html) {
  const headings = [];
  const re = /<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi;
  let m;
  while ((m = re.exec(html))) {
    const text = stripTags(m[2]).replace(/\s+/g, " ").trim();
    const hit = SECTION_RE.exec(text);
    headings.push({
      level: parseInt(m[1], 10),
      start: m.index,
      end: re.lastIndex,
      key: hit ? SECTION_MAP[hit[2]] : null,
    });
  }

  const sections = [];
  headings.forEach((h, i) => {
    if (!h.key) return;
    let stop = html.length;
    for (let j = i + 1; j < headings.length; j++) {
      if (headings[j].level <= h.level) {
        stop = headings[j].start;
        break;
      }
    }
    sections.push({ key: h.key, start: h.start, html: html.slice(h.end, stop) });
  });
  return sections;
}

function lastCapture(re, text) {
  let m;
  let found = "";
  re.lastIndex = 0;
  while ((m = re.exec(text))) {
    found = m[1];
    if (m[0].length === 0) re.lastIndex++;
  }
  return (found || "").trim();
}

const SEARCH_MENU_WORDS = /^(笔顺|筆順|五笔|五筆|仓颉|倉頡|四角|Unicode|拆分|索引)/;

/**
 * 解析页首信息：拼音、注音、部首、笔画、结构、异体字。
 *
 * @param {string} headerHtml 第一个分区标题之前的 HTML。
 * @return {Object} 头部信息。
 */
function parseHeader(headerHtml) {
  const text = htmlToLines(headerHtml).map(clean).join("\n");
  const pick = (re) => {
    const v = lastCapture(re, text);
    return SEARCH_MENU_WORDS.test(v) ? "" : v;
  };

  const info = {
    pinyin: pick(/(?:^|\n)拼音[ \t]*\n?([^\n]*)/g),
    zhuyin: pick(/(?:^|\n)注音[ \t]*\n?([^\n]*)/g),
    radical: pick(/(?:^|\n)部首[ \t]*\n?([^\n]*?)(?:总笔画|總筆畫|\n|$)/g),
    strokes: pick(/(?:总笔画|總筆畫)[ \t]*\n?(\d+)/g),
    structure: pick(/(?:字形结构|字形結構)[ \t]*\n?([^\n]*?)(?:字形分析|\n|$)/g),
    unicode: pick(/(?:统一码|統一碼)[ \t]*\n?([^\n]*?)(?:笔顺|筆順|\n|$)/g),
    variants: [],
  };

  const idx = headerHtml.search(/异体|異體/);
  if (idx >= 0) {
    const tail = headerHtml.slice(idx);
    const titleRe = /title="([^"]+)"/g;
    let m;
    while ((m = titleRe.exec(tail))) {
      const v = decodeEntities(m[1]).trim();
      if (v && info.variants.indexOf(v) === -1) info.variants.push(v);
    }
  }
  return info;
}

/**
 * 去掉注音符号（ㄅㄆㄇ…）及声调符号。
 */
function stripZhuyin(text) {
  return (text || "")
    .replace(/[\u3100-\u312f\u31a0-\u31bf\u02c7\u02c9\u02ca\u02cb\u02d9]/g, "")
    .replace(/[ \t]+/g, " ")
    .replace(/[ \t]+$/gm, "")
    .trim();
}

/**
 * 读音标签 “日本 rì běn” 去掉开头重复的词本身，只留拼音；去掉后为空则保持原样。
 */
function dropLeadingWord(label, word) {
  let rest = label;
  if (rest.indexOf(word) === 0) {
    rest = rest.slice(word.length).trim();
  } else {
    // 标签里的字与查询词写法不同（繁简差异、异体字）时，去掉开头紧跟拼音的汉字
    const m = /^(?:[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]|[\ud840-\ud884][\udc00-\udfff])+\s*(?=[A-Za-zāáǎàēéěèīíǐìōóǒòūúǔùüǖǘǚǜńňǹḿ])/.exec(rest);
    if (m) rest = rest.slice(m[0].length).trim();
  }
  return rest || label;
}

/**
 * 把 “好hǎoㄏㄠˇ” 之类的义项组标题拆开空格，方便阅读。
 */
function prettifyLabel(s) {
  return clean(s)
    .replace(/^(.*?)([A-Za-zāáǎàēéěèīíǐìōóǒòūúǔùüǖǘǚǜńňǹḿ])/, "$1 $2")
    .replace(/([A-Za-zāáǎàēéěèīíǐìōóǒòūúǔùüǖǘǚǜńňǹḿ])([\u3100-\u312f])/, "$1 $2")
    .trim();
}

// ---------------------------------------------------------------------------
// 义项处理
// ---------------------------------------------------------------------------

function stripExampleClause(text) {
  if (!text) return "";
  return text
    .replace(/\s*例如\s*[:：]?\s*[\s\S]*$/, "")
    .replace(/\s*[→←⇒⇐]+\s*$/, "")
    .trim();
}

/**
 * 去掉编号前缀、例句、结尾标点，得到用于去重与展示的“纯释义”。
 */
function normalizeMeaning(text) {
  return stripExampleClause(text)
    .replace(/^\d+\s*[.．、]\s*/, "")
    .replace(/^[(（]\s*\d+\s*[)）]\s*/, "")
    .replace(/^[\s·•]+/, "")
    .replace(/^\[[^\]]*\]\s*[∶:：]\s*/, "")
    .replace(/[。！？；\s]+$/, "")
    .replace(/\s*[→←⇒⇐]+\s*$/, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * 识别行首编号。顶层 “1.” 与子项 “(1)” 分别保留各自的写法，避免编号冲突。
 *
 * @return {?{label: string, body: string}}
 */
function parseIndex(line) {
  let m = /^(\d+)\s*[.．、]\s*([\s\S]*)$/.exec(line);
  if (m) return { label: m[1] + ".", body: m[2] };
  m = /^[(（]\s*(\d+)\s*[)）]\s*([\s\S]*)$/.exec(line);
  if (m) return { label: "(" + m[1] + ")", body: m[2] };
  return null;
}

/**
 * 把“一行里挤了多个编号义项”的文本拆开。
 * 只使用前瞻断言（不用后行断言），兼容旧版 macOS 的 JavaScriptCore。
 *
 * @return {Array<{label: string, body: string}>}
 */
function splitMeaningItems(text) {
  const cleaned = (text || "").trim();
  if (!cleaned) return [];

  const pieces = cleaned
    .replace(/([。！？；])\s*(?=(?:\d+\s*[.．、]|[(（]\s*\d+\s*[)）]))/g, "$1\u0001")
    .split("\u0001")
    .map((s) => s.trim())
    .filter(Boolean);

  const result = [];
  pieces.forEach((piece) => {
    const idx = parseIndex(piece);
    if (idx) result.push({ label: idx.label, body: idx.body });
    else result.push({ label: "", body: piece });
  });
  return result;
}

function pushUniqueMeaning(list, label, body) {
  const normalized = normalizeMeaning(body);
  if (!normalized) return;
  if (list.some((item) => normalizeMeaning(item) === normalized)) return;
  list.push(label ? `${label} ${normalized}` : normalized);
}

const SKIP_LINES = /^(反馈|反饋|書證|书证|\[?反[馈饋]\]?)$/;

/**
 * 词语解释里的编号（“1.” / “(1)”）常与释义分处两行，这里把它们并回一行。
 */
function mergeBareIndex(lines) {
  const out = [];
  const bare = /^(?:\d+\s*[.．、]|[(（]\s*\d+\s*[)）])$/;
  for (let i = 0; i < lines.length; i++) {
    const line = clean(lines[i]);
    if (bare.test(line)) {
      let j = i + 1;
      while (j < lines.length && !clean(lines[j])) j++;
      if (j < lines.length) {
        const next = clean(lines[j]);
        if (!bare.test(next) && !/^[●◎]/.test(next)) {
          out.push(line + " " + next);
          i = j;
          continue;
        }
      }
    }
    out.push(lines[i]);
  }
  return out;
}

/**
 * 解析“基本解释 / 词语解释”：●/◎ 开头是读音分组，“N. ” 开头是义项。
 *
 * @param {Array<string>} lines 分区文本行。
 * @return {{groups: Array<{part: string, means: Array<string>}>, english: Array<string>}}
 */
function parseDefinitions(lines) {
  lines = mergeBareIndex(lines);
  const groups = [];
  const english = [];
  let cur = null;

  const ensureGroup = () => {
    if (!cur) {
      cur = { part: "释义", means: [] };
      groups.push(cur);
    }
    return cur;
  };

  for (const raw of lines) {
    const line = clean(raw);
    if (!line || SKIP_LINES.test(line)) continue;

    const group = /^[●◎]\s*(.+)$/.exec(line);
    if (group) {
      const label = prettifyLabel(group[1]).trim();
      cur = { part: label || "释义", means: [] };
      groups.push(cur);
      continue;
    }

    if (parseIndex(line)) {
      const g = ensureGroup();
      splitMeaningItems(line).forEach((it) => pushUniqueMeaning(g.means, it.label, it.body));
      continue;
    }

    const en = /^英文\s*(.+)$/.exec(line);
    if (en) english.push(en[1]);
  }
  return { groups: groups.filter((g) => g.means.length > 0), english };
}

/**
 * 把分区文本行拼成一段文本（用于详细解释、国语辞典等长内容）。
 */
function linesToText(lines, maxChars) {
  const out = [];
  for (const raw of lines) {
    let line = clean(raw);
    if (!line || SKIP_LINES.test(line)) continue;
    if (line.indexOf("• ") === 0) line = "　· " + line.slice(2);
    out.push(line);
  }
  return truncate(out.join("\n"), maxChars, "…（内容过长，已截断）");
}

/**
 * 解析“成语”分区：解释 / 出处 / 示例 / 语法。
 */
function parseIdiom(lines) {
  const adds = [];
  for (const raw of lines) {
    const line = clean(raw);
    if (!line || SKIP_LINES.test(line)) continue;
    const m = /^(解释|解釋|出处|出處|示例|语法|語法|用法|辨析|故事)\s*(.+)$/.exec(line);
    if (m) adds.push({ name: m[1], value: m[2] });
    else if (adds.length) adds[adds.length - 1].value += "\n" + line;
  }
  return adds;
}

/**
 * 解析“近反义词”分区。
 *
 * @return {{synonyms: Array<string>, antonyms: Array<string>}}
 */
function parseSynonyms(lines) {
  const synonyms = [];
  const antonyms = [];
  const push = (arr, w) => {
    if (w && arr.indexOf(w) === -1) arr.push(w);
  };
  for (const raw of lines) {
    const parts = raw
      .split(LINK_MARK)
      .map((s) => s.trim())
      .filter((s) => s && !/^显示更多|^顯示更多/.test(s));
    if (parts.length < 2) continue;
    const label = parts[0];
    const words = parts.slice(1);
    if (/^(近义词|近義詞)$/.test(label)) words.forEach((w) => push(synonyms, w));
    else if (/^(反义词|反義詞)$/.test(label)) words.forEach((w) => push(antonyms, w));
  }
  return { synonyms, antonyms };
}

/**
 * 解析“翻译”分区（英语 / 德语 / 法语…）。
 */
function parseTranslations(lines) {
  const adds = [];
  const cleaned = lines.map(clean).filter((l) => l && !SKIP_LINES.test(l));
  for (let i = 0; i < cleaned.length; i++) {
    const m = /^(英语|英語|德语|德語|法语|法語|日语|日語|俄语|俄語)\s*[:：]?\s*(.*)$/.exec(cleaned[i]);
    if (!m) continue;
    let value = m[2];
    if (!value && i + 1 < cleaned.length) {
      value = cleaned[i + 1];
      i += 1;
    }
    if (value) adds.push({ name: LANG_LABEL_MAP[m[1]], value: value.replace(/\u200b/g, "") });
  }
  return adds;
}

/**
 * 解析整页，生成 Bob 的 toDict 结构。
 * 各分区按需转换成文本行（htmlToLines 较耗时，康熙字典、百科等大分区默认不处理）。
 *
 * @param {string} html 页面 HTML。
 * @param {string} word 查询词。
 * @param {string} url 页面地址。
 * @return {?{summary: string, toDict: Object}} 解析结果；无内容时返回 null。
 */
function parseEntry(html, word, url) {
  const sections = splitSections(html);
  if (sections.length === 0) {
    logInfo("汉典页面未找到任何已知分区（词条不存在，或页面结构已变更）");
    return null;
  }

  // key -> 该 key 下所有分区的 HTML
  const htmlOf = {};
  sections.forEach((s) => {
    (htmlOf[s.key] = htmlOf[s.key] || []).push(s.html);
  });

  // 按需、带缓存地取某分区的文本行
  const lineCache = {};
  const linesOf = (key) => {
    if (!htmlOf[key]) return null;
    if (!lineCache[key]) {
      lineCache[key] = htmlOf[key].reduce((acc, h) => acc.concat(htmlToLines(h)), []);
    }
    return lineCache[key];
  };

  const toDict = { word: word, parts: [], exchanges: [], additions: [] };

  // —— 核心释义 ——
  const defLines = linesOf("basic") || linesOf("word");
  const defs = defLines ? parseDefinitions(defLines) : { groups: [], english: [] };

  // 页首信息（懒解析，只解析一次）
  let header = null;
  const getHeader = () => {
    if (!header) {
      const firstStart = Math.min.apply(null, sections.map((s) => s.start));
      header = parseHeader(html.slice(0, firstStart));
    }
    return header;
  };

  // 词语解释的读音标签只保留拼音（词本身已在标题中显示，避免重复）
  const singleGroup = defs.groups.length === 1;
  defs.groups.forEach((g) => {
    let part = g.part;
    if (singleGroup && (!htmlOf.basic || part === "释义")) {
      const h = getHeader();
      if (h.pinyin) part = h.pinyin;
    }
    toDict.parts.push({ part: dropLeadingWord(stripZhuyin(part), word), means: g.means });
  });

  // 英文释义（如 日本 → Japan）
  defs.english.forEach((en) => toDict.additions.push({ name: "英文", value: en }));

  // —— 近义词 / 反义词 ——
  if (htmlOf.syn) {
    const sy = parseSynonyms(linesOf("syn"));
    if (sy.synonyms.length) toDict.exchanges.push({ name: "近义词", words: sy.synonyms.slice(0, 12) });
    if (sy.antonyms.length) toDict.exchanges.push({ name: "反义词", words: sy.antonyms.slice(0, 12) });
  }

  // —— 成语 ——
  const idiom = linesOf("idiom") ? parseIdiom(linesOf("idiom")) : [];
  idiom.forEach((a) => toDict.additions.push(a));

  // —— 国语辞典：仅在没有其他内容时作为兜底，避免返回空壳 ——
  let guoyuText = "";
  const hasCore = defs.groups.length || idiom.length;
  // 已有基本解释 / 词语解释 / 成语时不展示国语辞典，仅在没有其他内容时作为兜底
  if (htmlOf.guoyu && !hasCore) {
    guoyuText = stripZhuyin(linesToText(linesOf("guoyu"), 800));
    if (guoyuText) toDict.additions.push({ name: "国语辞典", value: guoyuText });
  }

  // 没有任何实质内容（既无释义、成语，也无国语辞典等）视为未找到
  if (toDict.parts.length === 0 && toDict.additions.length === 0) return null;

  // —— 页首信息（懒解析：仅在没有任何释义时用于摘要兜底）——
  if (!defs.groups.length && !idiom.length && !guoyuText) getHeader();

  // —— 摘要 ——
  let summary = "";
  if (defs.groups.length) summary = defs.groups[0].means[0].replace(/^(?:\d+\.|\(\d+\))\s*/, "");
  else if (idiom.length) summary = idiom[0].value;
  else if (guoyuText) summary = guoyuText.split("\n")[0];
  else summary = (header && header.pinyin) || word;
  summary = truncate(summary, 120);

  return { summary, toDict };
}

// ---------------------------------------------------------------------------
// 错误处理
// ---------------------------------------------------------------------------

/**
 * 通用错误处理函数
 *
 * @param {Object} err 错误对象。
 * @param {Object} query 查询对象。
 * @return {void}
 */
function handleError(err, query) {
  // 用户主动取消：Bob 已经丢弃该次查询，无需再弹错误
  if (err && err.cancelled) return;

  logError(`汉典插件错误: ${err && (err.stack || err.message || err)}`);

  let type = err && err.type;
  let message = (err && err.message) || String(err);
  if (!type) {
    type = "unknown";
    message += "\n\n请尝试重新查询，或检查网络后再试。";
  }
  query.onCompletion({
    error: {
      type: type,
      message: "出现错误: " + message,
      addtion: err && err.addtion,
      troubleshootingLink: err && err.troubleshootingLink,
    },
  });
}