// VoiceDrop 的 MCP 工具表。
//
// 每个工具 = {name, description, inputSchema, handler(args, {client})}。
// description 是写给模型看的——它只有这几行字来决定要不要调、怎么调，
// 所以该说的领域知识（算力单位、stem 是什么、[[photo:]] 标记）都写在里面。
//
// 有意不做：音频/照片的二进制上传下载。几 MB 的 base64 塞进模型上下文是灾难，
// App 已经干得很好。这里只给「列出」和「拿公开 URL」。

import { FILES_ORIGIN } from "./vd-client.js";
import { classifyCode, startPairing, finishPairing } from "./login.js";

const obj = (properties, required = []) => ({ type: "object", properties, required });
const str = (description) => ({ type: "string", description });
const int = (description) => ({ type: "integer", description });

const STEM = str(
  "文章的 stem（不含扩展名的文件名，形如 VoiceDrop-2026-07-13-143052-...）。用 list_articles 拿。",
);
const SHARE_ID = str("社区帖子的 shareId（12 位）。用 community_feed 拿。");
const SLUG = str("书的 slug（书架 URL 里的短名，形如 software-survivors-2000）。用 list_books 拿。");

// 书的公开阅读地址（给人看/下载用这个域名，微信里也能开）。
const bookURL = (slug, file = "") =>
  `https://voicedrop.cn/books/${encodeURIComponent(slug)}/${file}`;

// 章节 HTML → 可读纯文本。够用就好：书页是写书 skill 生成的规整文章 HTML，
// 不是任意网页。先摘掉 script/style 和公开路由注入的「听本章」播放器，
// 再把块级闭合换成换行、剥标签、解常用实体。
function htmlToText(html) {
  return String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<div id="abw"[\s\S]*?<\/div>/, "")
    .replace(/<(?:h[1-6])[^>]*>/gi, "\n\n")
    .replace(/<\/(?:p|div|h[1-6]|li|blockquote|tr|section|figure)>/gi, "\n")
    .replace(/<br[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export const TOOLS = [
  // ─────────────────────────── 登录 ───────────────────────────
  {
    name: "login",
    description:
      "用手机配对登录 VoiceDrop，拿到访问令牌。**要调两次**：\n" +
      "① 先问用户要手机「设置 → 账户」里的 6 位十六进制代码，传 `code` 调一次 → 用户手机上会弹出一个 4 位数字码，本次返回 pairing 句柄；\n" +
      "② 再问用户要那个 4 位数字码，传 `verify_code` + 上一步返回的 `pairing` 调第二次 → 返回访问令牌。\n" +
      "4 位码在第一步之前不存在（服务端现生成后推到手机上），所以省不掉这一次往返。\n" +
      "拿到令牌后要提醒用户：这是账号的完整密钥，不可吊销，别泄漏。",
    inputSchema: obj({
      code: str("第一步用：6 位十六进制代码（手机「设置 → 账户」里那串短 ID）。开始配对；第二步不传。"),
      verify_code: str("第二步用：手机弹出的 4 位数字码。必须和 pairing 一起传。"),
      pairing: str("第二步用：第一步返回的 pairing 句柄，原样复制。"),
    }),
    handler: async ({ code, verify_code, pairing }, ctx) => {
      // 兼容 2026-07 之前的调法：4 位码塞在 code 里 + pairing。悄悄搬到新家。
      if (!verify_code && pairing && classifyCode(code) === "verify") {
        verify_code = code;
        code = undefined;
      }

      if (verify_code !== undefined) {
        if (classifyCode(verify_code) !== "verify") {
          throw new Error("verify_code 应该是手机上弹出的 4 位数字码。");
        }
        if (!pairing) {
          throw new Error("verify_code 要和 pairing 一起传——pairing 是第一步返回的句柄，原样复制过来。");
        }
        const { token, scope } = await finishPairing(verify_code, pairing, ctx);
        return {
          token,
          scope,
          next:
            "登录成功。把这个令牌配进 MCP 客户端就能用了：\n" +
            `  claude mcp add voicedrop --transport http https://voicedrop.cn/mcp --header "Authorization: Bearer ${token}"\n` +
            "注意：这是账号的完整密钥，不可吊销、不会过期。谁拿到它就有你账号的全部权限——别贴到任何公开的地方。",
        };
      }

      if (classifyCode(code) !== "prefix") {
        throw new Error(
          "开始配对要传 code（6 位十六进制，手机「设置 → 账户」里那串）；" +
            "完成配对要传 verify_code（4 位数字）+ pairing。",
        );
      }

      const { pairing: handle, matchCount } = await startPairing(code, ctx);
      return {
        pairing: handle,
        matchCount,
        next:
          "现在看你的手机——App 里会弹出一个 4 位数字码。" +
          "把那个 4 位码用 verify_code 参数、连同上面这个 pairing 一起，再调一次 login。（2 分钟内有效）",
      };
    },
  },

  // ─────────────────────────── 文章 ───────────────────────────
  {
    name: "list_articles",
    description:
      "列出我的全部文章（最新在前）。返回每篇的 stem、标题、当前版本号 head、节数 count、创建/更新时间。" +
      "这是所有文章操作的入口——先用它拿 stem。",
    inputSchema: obj({}),
    handler: (_a, { client }) => client.files("GET", "articles"),
  },
  {
    name: "read_article",
    description:
      "读一篇文章的全文。返回 articles[{title, body}]（body 是 Markdown 正文）、口述原文 transcript、" +
      "以及元数据。正文里的 [[photo:photos/...]] 是内嵌照片标记，要展示的话用 photo_url 换成可访问的 URL。",
    inputSchema: obj({ stem: STEM }, ["stem"]),
    handler: ({ stem }, { client }) => client.files("GET", ["articles", stem]),
  },
  {
    name: "write_article",
    description:
      "写一篇文章：stem 已存在就改写，是新的就新建。这是版本化写入：每次写都追加一个新版本、" +
      "head 前移，旧版本还在（可用 article_history 看、set_article_version 撤销）。新建时会自动补一个" +
      "静音占位录音，文章才会出现在「我的录音」里。注意：正文里已有的 [[photo:...]] 标记要原样保留，" +
      "否则照片会从文章里消失。",
    inputSchema: obj(
      {
        stem: STEM,
        articles: {
          type: "array",
          description: "新的文章内容。一次录音可以出多篇，所以这是数组。",
          items: obj({ title: str("标题"), body: str("Markdown 正文") }, ["title", "body"]),
        },
      },
      ["stem", "articles"],
    ),
    handler: ({ stem, articles }, { client }) =>
      client.files("PUT", ["articles", stem], { body: { articles } }),
  },
  {
    name: "article_history",
    description: "看一篇文章的版本历史（最多保留 10 版）。返回当前 head 和每个版本的内容、保存时间、来源。",
    inputSchema: obj({ stem: STEM }, ["stem"]),
    handler: ({ stem }, { client }) => client.files("GET", ["articles", stem, "history"]),
  },
  {
    name: "set_article_version",
    description:
      "撤销/重做：把文章的 head 指针挪到指定版本。只移指针，不产生新版本。版本号从 article_history 拿。",
    inputSchema: obj({ stem: STEM, head: int("要切到的版本号") }, ["stem", "head"]),
    handler: ({ stem, head }, { client }) =>
      client.files("PATCH", ["articles", stem, "head"], { body: { head } }),
  },
  {
    name: "delete_article",
    description:
      "删除一篇文章，连同它的 .srt/.empty/.blocked 边车。不会删掉原始录音——录音还在，下次挖矿会重新成文。",
    inputSchema: obj({ stem: STEM }, ["stem"]),
    handler: ({ stem }, { client }) => client.files("DELETE", ["articles", stem]),
  },

  // ─────────────────────────── 文风 ───────────────────────────
  {
    name: "read_style",
    description:
      "读我的写作风格。挖矿时这份会被叠进 system prompt，决定文章写成什么样。" +
      "返回当前 style 正文、名字 name、版本 head。如果 default:true，说明还没自定义过，用的是默认风格。",
    inputSchema: obj({}),
    handler: (_a, { client }) => client.files("GET", "style"),
  },
  {
    name: "write_style",
    description:
      "改写我的写作风格（版本化，同文章）。风格描述要写成可执行的规则——" +
      "「单句成段，段落 1–3 句居多」这种模型能照做的，而不是「喜欢短句」这种模糊的。改完下次挖矿自动生效。",
    inputSchema: obj({ style: str("风格正文（Markdown）"), name: str("我的名字（可选）") }, ["style"]),
    handler: ({ style, name }, { client }) =>
      client.files("PUT", "style", { body: name === undefined ? { style } : { style, name } }),
  },
  {
    name: "style_history",
    description: "看写作风格的版本历史。",
    inputSchema: obj({}),
    handler: (_a, { client }) => client.files("GET", "style/history"),
  },
  {
    name: "set_style_version",
    description: "撤销/重做写作风格：把 head 挪到指定版本，不产生新版本。",
    inputSchema: obj({ head: int("要切到的版本号") }, ["head"]),
    handler: ({ head }, { client }) => client.files("PATCH", "style/head", { body: { head } }),
  },
  {
    name: "collect_style_sample",
    description:
      "往风格语料库里加一篇样本（我以前写的东西）。攒够语料后用 extract_style 一次性蒸馏成写作风格。",
    inputSchema: obj(
      { text: str("样本全文"), title: str("样本标题（可选）"), type: str("样本类型（可选）") },
      ["text"],
    ),
    handler: ({ text, title, type }, { client }) =>
      client.files("POST", "style/collect", { body: { text, title, type } }),
  },
  {
    name: "list_style_dataset",
    description: "列出风格语料库里已有的样本（只有元数据，不含正文）。返回总条数和总字数。",
    inputSchema: obj({}),
    handler: (_a, { client }) => client.files("GET", "style/dataset"),
  },
  {
    name: "extract_style",
    description:
      "从语料库蒸馏出写作风格：服务端读完 collect_style_sample 攒的全部样本，提炼成一份新的写作风格" +
      "（写成新版本），并生成一篇「风格介绍」文章。语料太少会报错。这一步花算力。",
    inputSchema: obj({
      clearAfter: { type: "boolean", description: "蒸馏完是否清空语料库（默认否）" },
    }),
    handler: ({ clearAfter }, { client }) =>
      client.agent("POST", "style/extract", { body: { clearAfter: !!clearAfter } }),
  },

  // ─────────────────────────── 提示词 ───────────────────────────
  // 提示词 = 长按菜单里那些可自定义的 AI 指令（App 的 设置 → 提示词）。
  // 分享机制是数字「魔法数字」（4 位起步，占满自动加长；老码 7 位）：
  // 一条提示词一辈子一个码，码同时是短链
  // voicedrop.cn/<码>；别人可以用码导入成自己的副本，也可以在语音指令里
  // 直接念这个码一次性借用（不改自己的设置）。
  {
    name: "list_prompts",
    description:
      "列出我的全部提示词（长按菜单里的 AI 指令，含分组）。返回解析后的树：每项有 id、label、" +
      "prompt 正文、appliesTo（text/image，即出现在长按文字还是长按图片菜单）。" +
      "id 是提示词分享操作的入口——share_prompt / unshare_prompt 都要用它。" +
      "id 形如 sys_*（系统默认项）或 p_*（自建/改过的项）。",
    inputSchema: obj({}),
    handler: (_a, { client }) => client.agent("GET", "prompts"),
  },
  {
    name: "share_prompt",
    description:
      "把我的一条提示词分享出去：生成数字分享码（4 位起步，同时是 voicedrop.cn/<码> 短链），" +
      "并【自动发一个社区帖】（社区里大家能看到、导入、投币、回应）。需要 Apple 或微信登录" +
      "后的身份（匿名 token 会被拒并提示登录）。一条提示词一辈子一个码——重复调用返回同一个码，" +
      "关掉再开也是同码复活、社区帖同步复活。之后我改这条提示词，分享内容和社区帖自动跟着更新。" +
      "id 用 list_prompts 拿。返回里的 communityShareId 是社区帖 id。",
    inputSchema: obj({ id: str("提示词的 id（sys_* 或 p_*），从 list_prompts 拿。") }, ["id"]),
    handler: ({ id }, { client }) => client.agent("POST", "prompt-share", { body: { id } }),
  },
  {
    name: "unshare_prompt",
    description:
      "停止分享一条提示词：分享码立即失效（别人再用码会被告知「分享已停止」），社区帖同步撤下。" +
      "码不会易主——之后再对同一条 share_prompt，还是原来那个码、原来那个帖。",
    inputSchema: obj({ id: str("提示词的 id（sys_* 或 p_*），从 list_prompts 拿。") }, ["id"]),
    handler: ({ id }, { client }) => client.agent("DELETE", ["prompt-share", id]),
  },
  {
    name: "prompt_share_status",
    description:
      "查我的提示词分享状态一览：哪些条目铸过码、码是多少、当前是否在分享中。" +
      "返回 byItem：{<提示词id>: {code, sharing, borrowed?}}。没铸过码的条目不出现。" +
      "borrowed:true 表示这是导入件在转发原作者的码（不是我的自有码，关掉不会使码失效）。",
    inputSchema: obj({}),
    handler: (_a, { client }) => client.agent("GET", "prompt-shares"),
  },
  {
    name: "preview_prompt_share",
    description:
      "用分享码预览一条别人分享的提示词（公开接口，看内容不需要对方授权）。" +
      "返回 label、prompt 正文、appliesTo、作者名 author（作者没设名字则为空）、被导入次数 importCount。" +
      "只想看看是什么就用这个；确定要收下用 import_prompt。码无效或已停止分享会报 404。",
    inputSchema: obj({ code: str("数字分享码（4–16 位、首位非零），形如 4563 或 4563566。") }, ["code"]),
    handler: ({ code }, { client }) => client.agent("GET", ["prompt-share", code]),
  },
  {
    name: "import_prompt",
    description:
      "用分享码把别人分享的提示词导入成我自己的独立副本（出现在我的长按菜单里，可改名改词可删）。" +
      "是快照不是订阅：导入后原作者再改，不影响我这份。返回导入后的条目 item（含新 id）。",
    inputSchema: obj({ code: str("数字分享码（4–16 位、首位非零），形如 4563 或 4563566。") }, ["code"]),
    handler: ({ code }, { client }) => client.agent("POST", "prompts/import", { body: { code } }),
  },

  // ─────────────────────────── 挖矿 ───────────────────────────
  {
    name: "trigger_mining",
    description:
      "催一下挖矿：把还没成文的录音立刻处理掉（ASR → 大模型写文章）。平时上传录音会自动触发，" +
      "这个是加急用的。异步——返回后过一会儿再 list_articles 看结果。花算力。",
    inputSchema: obj({}),
    handler: (_a, { client }) => client.agent("POST", "mine/trigger"),
  },
  {
    name: "restyle_article",
    description:
      "用写作风格重写一篇已有文章：从它存下来的口述原文重新生成，套上指定版本的风格。" +
      "结果写成新版本（head 前移），可以用 set_article_version 撤回。不给 styleV 就用当前风格。花算力。",
    inputSchema: obj({ stem: STEM, styleV: int("风格版本号（可选，默认当前）") }, ["stem"]),
    handler: ({ stem, styleV }, { client }) =>
      client.agent("POST", "restyle", { body: styleV === undefined ? { stem } : { stem, styleV } }),
  },

  // ─────────────────────────── 社区 ───────────────────────────
  {
    name: "community_feed",
    description:
      "看社区列表：别人分享出来的文章，带推荐排序、点赞数、回复数、我有没有投过币。" +
      "返回 posts[] 和推荐顺序 order[]。要看某帖全文用 read_community_post。",
    inputSchema: obj({}),
    handler: async (_a, { client }) => {
      try {
        return await client.reco("GET", "feed");
      } catch (e) {
        // reco worker 没设 SESSION_SECRET，只认 anon_ token——Apple session JWT
        // 打过去必然 401。D1 挂了则是 503。这两种情况回退到核心的时间序列表，
        // 正是 app 自己的兜底策略（reco/wrangler.jsonc 开头就写着）。
        // 500 之类是真故障，不吞。
        if (e.status !== 401 && e.status !== 503) throw e;
        const out = await client.files("GET", "community/list");
        return { ...out, fallback: true, fallbackReason: `reco 不可用（${e.status}），退回时间序列表` };
      }
    },
  },
  {
    name: "read_community_post",
    description:
      "读一个社区帖子的全文。内容是实时从原文章读的——作者改了文章，这里立刻跟着变。" +
      "返回里的 owner + [[photo:...]] 标记可以拼给 photo_url 换成图片 URL。",
    inputSchema: obj({ shareId: SHARE_ID }, ["shareId"]),
    handler: ({ shareId }, { client }) => client.files("GET", ["community", "get", shareId]),
  },
  {
    name: "community_replies",
    description: "看一个社区帖子下面的回复（社区是一层扁平线程，回复不再嵌套）。",
    inputSchema: obj({ shareId: SHARE_ID }, ["shareId"]),
    handler: ({ shareId }, { client }) => client.files("GET", ["community", "replies", shareId]),
  },
  {
    name: "share_to_community",
    description:
      "把我的一篇文章分享到社区。带 replyTo 就是作为某个帖子的回复发出去。" +
      "同一篇文章重复分享 = 原地更新，不会刷屏。需要 Apple 或微信登录后的身份（匿名 token 会被拒）。",
    inputSchema: obj({ stem: STEM, replyTo: str("要回复的帖子 shareId（可选）") }, ["stem"]),
    handler: ({ stem, replyTo }, { client }) =>
      client.files("POST", ["community", "share", "articles", `${stem}.json`], {
        body: replyTo === undefined ? {} : { replyTo },
      }),
  },
  {
    name: "unshare_from_community",
    description: "把我分享到社区的帖子撤回。只能撤自己的。需要 Apple 或微信登录后的身份。",
    inputSchema: obj({ shareId: SHARE_ID }, ["shareId"]),
    handler: ({ shareId }, { client }) => client.files("POST", ["community", "unshare", shareId]),
  },
  {
    name: "is_shared",
    description: "查我的某篇文章有没有分享到社区，分享了的话 shareId 是多少。",
    inputSchema: obj({ stem: STEM }, ["stem"]),
    handler: ({ stem }, { client }) =>
      client.files("GET", ["community", "shared", "articles", `${stem}.json`]),
  },
  {
    name: "feed_coin",
    description:
      "给社区里的一篇文章投币（点赞的强化版）：铸出金币，作者和投币人双方都拿到算力。" +
      "同一篇文章每人只能投一次。需要 Apple 或微信登录后的身份。",
    inputSchema: obj({ shareId: SHARE_ID }, ["shareId"]),
    handler: ({ shareId }, { client }) => client.agent("POST", "feed", { body: { share_id: shareId } }),
  },

  // ─────────────────────────── 算力 ───────────────────────────
  {
    name: "credit_balance",
    description:
      "查算力余额。算力是 VoiceDrop 的计费单位，23 算力 = 1 元。挖矿、改稿、蒸馏文风都花算力。" +
      "返回 suanli（余额）、yuan（折合人民币）、granted_suanli（累计获得）、spent_suanli（累计花掉）。",
    inputSchema: obj({}),
    handler: (_a, { client }) => client.agent("GET", "usage/balance"),
  },
  {
    name: "credit_ledger",
    description:
      "查算力流水（每一笔收支）。kind 是 grant（获得）或 spend（花掉），reason 说明是干什么花的" +
      "（挖矿 / 改稿 / 语音识别 / 投币 / 邀请…）。",
    inputSchema: obj({
      limit: int("要几条（默认 50）"),
      before: str("翻页游标，从上一页的 next 拿"),
    }),
    handler: ({ limit, before }, { client }) =>
      client.agent("GET", "usage/ledger", { query: { limit: limit ?? 50, before } }),
  },
  {
    name: "credit_summary",
    description: "算力收支汇总：按用途分组，看清楚算力都从哪来、花到哪去了。",
    inputSchema: obj({}),
    handler: (_a, { client }) => client.agent("GET", "usage/summary"),
  },

  // ─────────────────────────── 发布 ───────────────────────────
  {
    name: "share_link",
    description: "给一篇文章生成公开分享链接（voicedrop.cn/<id>，任何人无需登录都能看）。",
    inputSchema: obj({ stem: STEM }, ["stem"]),
    handler: ({ stem }, { client }) => client.files("GET", ["share", "articles", `${stem}.json`]),
  },
  {
    name: "publish_wechat",
    description:
      "把一篇文章发到我的微信公众号草稿箱（同步执行，返回时草稿已经在了）。" +
      "需要先在 App 设置里配好公众号的 appid 和 secret。",
    inputSchema: obj({ stem: STEM }, ["stem"]),
    handler: ({ stem }, { client }) => client.files("POST", ["wechat", "articles", `${stem}.json`]),
  },
  {
    name: "xhs_pack",
    description: "把一篇文章改写成小红书文案（配上图片 key）。花算力。",
    inputSchema: obj({ stem: STEM }, ["stem"]),
    handler: ({ stem }, { client }) => client.agent("POST", "xhs-pack", { body: { stem } }),
  },

  // ─────────────────────────── 书 ───────────────────────────
  // 公开书架 voicedrop.cn/books：写书 agent（lab.jianshuo.dev）长出来的书。
  // 读（list_books / read_book / read_book_chapter）是公开内容，免 token
  // （http.js 的 NO_TOKEN_TOOLS）；写和修走 lab API，扣算力、要 token。
  {
    name: "list_books",
    description:
      "看公开书架（voicedrop.cn/books）上的全部书。返回每本的 slug、书名、作者、类目、章节数、" +
      "有无封面、创建时间和阅读 URL。书架是公开内容，不花算力、不需要登录。" +
      "读目录用 read_book，读正文用 read_book_chapter。",
    inputSchema: obj({}),
    handler: async (_a, { client }) => {
      const out = await client.books("GET", "", { query: { format: "json" } });
      const books = (out.books ?? []).map(({ slug, title, author, category, chapters, cover, createdAt }) => ({
        slug, title, author, category, chapters, cover, createdAt, url: bookURL(slug),
      }));
      return { count: books.length, books };
    },
  },
  {
    name: "read_book",
    description:
      "看一本书的目录和梗概：书名、副题、一句话简介、每章的编号 + 标题 + 梗概 + 状态" +
      "（老书没有源数据，只回章节编号清单）。公开内容，不需要登录。" +
      "拿到章节编号后用 read_book_chapter 读正文。",
    inputSchema: obj({ slug: SLUG }, ["slug"]),
    handler: async ({ slug }, { client }) => {
      const url = bookURL(slug);
      // 新书：写书 skill 把源数据镜像在 _src/book.json（含每章 brief/status）。
      try {
        const src = await client.books("GET", [slug, "_src", "book.json"]);
        if (src && typeof src === "object" && Array.isArray(src.chapters)) {
          const { title, subtitle, tagline, type } = src;
          return {
            slug, title, subtitle, tagline, type, url,
            chapters: src.chapters.map((c) => ({
              chapter: String(c.no).padStart(2, "0"), title: c.title, brief: c.brief, status: c.status,
            })),
          };
        }
      } catch (e) {
        if (e.status !== 404) throw e;
      }
      // 老书（没镜像源数据）：从 index.html 抠 <title> 和章节链接（01.html…NN.html）。
      const html = String(await client.books("GET", [slug, "index.html"]));
      const title = (/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? slug).trim();
      const chapters = [...new Set([...html.matchAll(/href="(\d+)\.html"/g)].map((m) => m[1]))]
        .sort()
        .map((n) => ({ chapter: n }));
      return { slug, title, url, chapters };
    },
  },
  {
    name: "read_book_chapter",
    description:
      "读（下载）一本书的一章正文，HTML 已转成纯文本。chapter 用 read_book 返回的编号（01、02…）；" +
      "intro 是序章。公开内容，不需要登录。返回里的 url 是网页原版（排版、插图俱全），" +
      "要给人看或下载就给 url。",
    inputSchema: obj(
      { slug: SLUG, chapter: str("章节编号（01、02…，用 read_book 拿），或 intro（序章）") },
      ["slug", "chapter"],
    ),
    handler: async ({ slug, chapter }, { client }) => {
      const stem = /^\d$/.test(chapter) ? `0${chapter}` : chapter; // 容忍 "1" → "01"
      const html = String(await client.books("GET", [slug, `${stem}.html`]));
      return { slug, chapter: stem, url: bookURL(slug, `${stem}.html`), text: htmlToText(html) };
    },
  },
  {
    name: "write_book",
    description:
      "写一本新书：把一个「中心思想」（seed）交给云端写书 agent——它拆大纲、逐章写正文（费曼式白话）、" +
      "独立评审过稿，一章一章增量上架到公开书架 voicedrop.cn/books。一口价按算力计（价钱以" +
      "服务端为准，余额不够会直接告诉你这次要多少），扣费成功即受理" +
      "（fire-and-forget），整本书要几十分钟长成：书很快出现在 list_books，章节逐章补齐，" +
      "进度用 book_history 看。署名用我在 App 设置里的名字。",
    inputSchema: obj({ seed: str("中心思想：想让这本书讲什么。一两句话到一段话都行。") }, ["seed"]),
    handler: async ({ seed }, { client }) => {
      const out = await client.lab("POST", "book", { body: { seed } });
      return {
        ...(out && typeof out === "object" ? out : { response: out }),
        next:
          "已受理，开写了（一本书的算力已扣清）。整本书要几十分钟：先用 list_books 等它上架，" +
          "再用 book_history 看逐章进度。现在关掉对话也不影响。",
      };
    },
  },
  {
    name: "revise_book",
    description:
      "修改我写的一本书：给云端写书 agent 发一条修改指令（只有书的主人能修）。一口价 40 算力，" +
      "受理后异步执行——用 book_history 看进度，改完那条的 reply 就是 agent 的修改说明。",
    inputSchema: obj(
      { slug: SLUG, instruction: str("修改指令，例如「第三章太啰嗦，砍掉一半」「换个更口语的书名」") },
      ["slug", "instruction"],
    ),
    handler: async ({ slug, instruction }, { client }) => {
      const out = await client.lab("POST", "book/revise", { body: { slug, instruction } });
      return {
        ...(out && typeof out === "object" ? out : { response: out }),
        next: "已受理（40 算力已扣）。异步执行中，用 book_history 看进度和修改说明。",
      };
    },
  },
  {
    name: "book_history",
    description:
      "看一本书的写作/修改对话线（只有书的主人可见）：第一条是开书种子，之后每条是修改指令 + " +
      "agent 的回执（status running→done，reply 是修改说明）。running:true 表示还有任务在跑。" +
      "403 = 不是这本书的主人；404 = 登记簿上线前的老书。",
    inputSchema: obj({ slug: SLUG }, ["slug"]),
    handler: ({ slug }, { client }) => client.lab("GET", "book/history", { query: { slug } }),
  },

  // ────────────────────── 媒体与身份 ──────────────────────
  {
    name: "whoami",
    description: "我是谁：返回当前 token 对应的账号 scope。用来确认 token 有效、以及自己是哪个账号。",
    inputSchema: obj({}),
    handler: (_a, { client }) => client.files("GET", "whoami"),
  },
  {
    name: "list_files",
    description:
      "列出我账号下的文件。kind=audio 只看录音（VoiceDrop-*.m4a），kind=photos 只看照片，不给就全列。" +
      "录音有没有成文，看 list_articles 里有没有同名 stem。",
    inputSchema: obj({
      kind: { type: "string", enum: ["all", "audio", "photos"], description: "过滤（默认 all）" },
    }),
    handler: async ({ kind = "all" }, { client }) => {
      const out = await client.files("GET", "list");
      if (kind === "all") return out;
      const keep =
        kind === "audio"
          ? (n) => n.endsWith(".m4a")
          : (n) => n.startsWith("photos/") || n.includes("/photos/");
      return { ...out, files: (out.files ?? []).filter((f) => keep(f.name)) };
    },
  },
  {
    name: "photo_url",
    description:
      "把照片标记换成公开可访问的图片 URL。文章正文里的 [[photo:photos/xxx.jpg]]，" +
      "photos/xxx.jpg 就是这里的 key；owner 从 read_community_post 的返回里拿，自己的文章用 whoami 的 scope。" +
      "拼出来的 URL 无需 token，可以直接给出去。",
    inputSchema: obj(
      {
        owner: str("账号 scope，形如 users/anon-abc/"),
        key: str("照片的相对 key，形如 photos/2026-07-13-120000/5-x9q.jpg"),
      },
      ["owner", "key"],
    ),
    // 纯计算，不打网络。
    handler: async ({ owner, key }) =>
      `${FILES_ORIGIN}/files/api/photo/${owner.replace(/\/$/, "")}/${key.replace(/^\//, "")}`,
  },
];
