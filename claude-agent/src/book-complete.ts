// src/book-complete.ts — 写书收尾前的完成度对账（2026-09-23）。
//
// 起因：《一封一封的写》（dudu-de-xin）——Kimi 腿把「画剩下 13 页」的脚本 run_in_background
// 丢到后台、挂个 Monitor，然后写一段「每页出图后我会……」的总结就结束了回合。对 Agent SDK
// 来说回合结束 = 任务结束：后台脚本随进程一起死，runner 只看「引擎没抛错」，照常登记、
// 发书帖、推送「书写好了」——用户收到的是一本 1/14 的书，不退款不告警。
//
// 这里只做一件事：读工作目录 book.json（build.mjs done 的真源），数有几页还不是 done、
// 封面在不在。runner 拿到「还差什么」再喂回引擎续写；续写仍不齐才算失败。
// 纯函数 assessBook 独立出来给单测钉边界。
import { stat } from "node:fs/promises";
import { join } from "node:path";
import { findBookByJobId } from "./bookmeta.js";
import { WORKSPACE } from "./env.js";

export type BookGap = {
  slug: string;
  total: number;
  done: number;
  missing: number[];      // 还不是 done 的章节号
  coverMissing: boolean;
  summary: string;        // 给日志/告警用的一句话
};

// book：工作目录里的 book.json；hasCover：<workdir>/cover.jpg 在不在。
// 返回 null = 齐了。章节以 status === "done" 为准（build.mjs done 才会写）。
export function assessBook(book: any, hasCover: boolean): BookGap | null {
  const chapters: any[] = Array.isArray(book?.chapters) ? book.chapters : [];
  const missing = chapters
    .map((c, i) => ({ c, no: Number.isInteger(c?.no) ? Number(c.no) : i + 1 }))
    .filter(({ c }) => c?.status !== "done")
    .map(({ no }) => no);
  const coverMissing = !hasCover && !book?.cover;
  if (!missing.length && !coverMissing) return null;
  const slug = String(book?.slug ?? "");
  const parts: string[] = [];
  if (missing.length) parts.push(`${chapters.length - missing.length}/${chapters.length} 章 done，缺第 ${missing.join("、")} 章`);
  if (coverMissing) parts.push("缺封面");
  return { slug, total: chapters.length, done: chapters.length - missing.length, missing, coverMissing, summary: parts.join("；") };
}

// 硬缺口 = 有章节没发。只缺封面不算硬缺口（封面缺失有自己的病史，见
// voicedrop-book-cover-missing-causes：paint 与写书腿共用额度池，把它判成失败会把
// 「书好了只差封面」变成退款）。
export function isHardGap(gap: BookGap | null): boolean {
  return Boolean(gap && gap.missing.length);
}

export async function bookGap(jobId: string): Promise<BookGap | null | undefined> {
  const hit = await findBookByJobId(jobId);
  if (!hit) return undefined; // 连 book.json 都没有——交给 runner 原有的 _unmatched 路径
  let hasCover = false;
  try {
    hasCover = (await stat(join(hit.dir, "cover.jpg"))).size > 0;
  } catch {
    /* 没有 */
  }
  return assessBook(hit.book, hasCover);
}

// 喂回引擎的续写提示。要点：①说清还差什么；②点名不许把 paint/build.mjs 放后台——
// 这是本次事故的直接死因；③沿用续跑三不：不另起、不换 slug、不重画重写。
export function continueHint(gap: BookGap, round: number): string {
  const todo: string[] = [];
  if (gap.missing.length) todo.push(`把第 ${gap.missing.join("、")} 章（页）做完：有稿的补插图后 build.mjs done，缺稿的先写再评再发`);
  if (gap.coverMissing) todo.push("画封面 cover.jpg 并 build.mjs asset 上传");
  return (
    `\n\n补充（本单第 ${round} 次续写）：上一回合你在书还没写完时就结束了回合——` +
    `服务器对账 ${WORKSPACE}/book-${gap.slug}/book.json 发现：${gap.summary}。` +
    `工作目录 ${WORKSPACE}/book-${gap.slug}/ 里已有的 book.json / chapters / reviews / 插图都保留着，先 build.mjs status 对账，然后只补缺的：` +
    todo.join("；") +
    `；最后 build.mjs index 刷目录。` +
    `**不要另起一本新书、不要换 slug、不要重画已有的插图、不要重写已过审的章节。** ` +
    `**paint 和 build.mjs 一律前台同步跑到出结果，绝不用 run_in_background / nohup / Monitor 丢到后台**——` +
    `你的回合一结束进程就退出，后台任务会被一起杀掉，这正是上一回合没写完的原因。` +
    `全部章节 done、封面上传、目录刷新之后才能结束回合。`
  );
}
