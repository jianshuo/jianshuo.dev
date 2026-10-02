import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

// src/groups.ts — 风格一致性的 group 粘性（2026-10-02）。
//
// 一本书的几十张图如果一半 Codex（gpt-image-2）、一半 Seedream 出，画风会明显两样。
// 调用方给同一本书的每张图带同一个 group（如书的 slug）：这组里只要有一张是 Seedream
// 出的（降级或显式），之后这组的 auto 单都直走 Seedream，不再回头用 Codex。
// 落盘在 DATA_DIR/groups.json（重启不丢），TTL 默认 7 天（一本书写完早就过了）。

export interface GroupEntry {
  engine: "seedream";
  /** 第一次粘上的时刻（ISO） */
  since: string;
  /** 过期时刻（ms epoch），每次命中/写入顺延 */
  expires: number;
}

export class GroupStore {
  private cache: Record<string, GroupEntry> | null = null;
  private chain: Promise<unknown> = Promise.resolve();

  constructor(private file: string, private ttlMs: number) {}

  private async load(): Promise<Record<string, GroupEntry>> {
    if (this.cache) return this.cache;
    try {
      this.cache = JSON.parse(await readFile(this.file, "utf8"));
    } catch {
      this.cache = {};
    }
    return this.cache!;
  }

  async get(group: string | undefined, now = Date.now()): Promise<GroupEntry | undefined> {
    if (!group) return undefined;
    const all = await this.load();
    const e = all[group];
    return e && e.expires > now ? e : undefined;
  }

  /** 把 group 粘到 seedream（已粘的只顺延过期时刻）；顺手清掉过期条目 */
  async stick(group: string, now = Date.now()): Promise<void> {
    const run = async () => {
      const all = await this.load();
      for (const [k, v] of Object.entries(all)) if (v.expires <= now) delete all[k];
      const prev = all[group];
      all[group] = { engine: "seedream", since: prev?.since ?? new Date(now).toISOString(), expires: now + this.ttlMs };
      await mkdir(dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      await writeFile(tmp, JSON.stringify(all, null, 2));
      await rename(tmp, this.file);
    };
    const p = this.chain.then(run, run);
    this.chain = p.catch(() => {});
    return p;
  }
}
