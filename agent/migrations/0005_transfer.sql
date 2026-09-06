-- migrations/0005_transfer.sql — 用户之间的算力转账（一人把自己的算力转给另一个人）
-- 与 mint 的分工相反：mint 是**铸币**（双方凭空多出算力），transfer 是**搬运**（总量不变）。
-- 钱仍然只认 bucket/ledger；本表是转账事件的业务事实源 + 幂等键的载体。
--
-- id 是**客户端可指定的幂等键**，且是主键：整笔转账（转出方扣桶 + 收款方新桶 +
-- 两边 account/ledger + 这一行）在同一个 db.batch 里落地，batch 就是一个事务。
-- 重复提交撞主键 → 整个事务回滚 → 一分钱都没动，然后按 id 把已有那笔原样回给调用方。
-- 这比「先 INSERT OR IGNORE 抢键再付钱」更严：那种写法在抢到键之后、付钱之前崩掉
-- 会留下一笔有事件无资金的账（mint 认了这个 known limitation，因为它只是少发一笔
-- 奖励；转账崩在这里却是转出方的钱凭空蒸发，不能认）。
CREATE TABLE IF NOT EXISTS transfer (
  id         TEXT PRIMARY KEY,     -- 幂等键（调用方给，或服务端生成）
  from_sub   TEXT NOT NULL,        -- 转出方 scope
  to_sub     TEXT NOT NULL,        -- 收款方 scope
  amount_uy  INTEGER NOT NULL,     -- 金额（微元，与 bucket/ledger 同单位）
  note       TEXT,                 -- 备注，两边账本都看得到
  ts         INTEGER NOT NULL      -- ms epoch
);
CREATE INDEX IF NOT EXISTS idx_transfer_from ON transfer (from_sub, ts);  -- 单日限额统计 + 对账
CREATE INDEX IF NOT EXISTS idx_transfer_to   ON transfer (to_sub, ts);
