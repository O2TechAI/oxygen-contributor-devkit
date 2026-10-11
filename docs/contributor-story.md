# Contributor story and experience — Zihan (3 / 4 / 5)

This is the copy and implementation brief for the contribution page and review
prompts. Contributor-facing web copy is English, matching the existing devkit.
The Chinese pitches below can be used in a team discussion or invitation.

## 30 秒 pitch

你和 agent 一起做完一个任务，留下来的不应该只有代码和答案。
真正值得复用的，往往是中间那次纠正、一次失败之后的判断，以及最后找到的方法。
Oxygen 把这些过程整理成有证据的 summary 和 skill 候选。
你不用重新写一篇教程：选一段自己熟悉的工作，检查它有没有说对，改掉不准确的地方，
留下真正有用的方法。拒绝一个站不住脚的 insight，也是有价值的贡献。
先从一个 session 开始，让下一次遇到类似问题的人少走一点弯路。

## 两分钟 story

一次 agent session 结束时，我们通常会留下最终产物，却忘记它为什么变成这样。
但真正体现经验的，可能是你告诉 agent「先别改代码，比较一下两个环境」，
也可能是第一次尝试失败后，大家才发现了一个之前没意识到的约束。
只看最后的答案，这些判断很容易消失。

Oxygen 想留下的是这些可复用的方法，而不是更多聊天记录。
它把过程整理成能读的 summary，把可能迁移到其他任务的方法写成 skill 候选，
并把候选和 summary 证据连起来。你最了解当时的上下文，所以你的工作不是
替机器盖章，而是判断：事情是不是这样发生的？方法有没有用？结果有没有夸大？
有没有遗漏你真正学到的东西？

可以从一段熟悉的 session 开始。先读 summary，再看候选的触发条件、方法和例子，
打开引用的证据。准确且有用就保留，有偏差就修改，没有依据就拒绝，缺了就补一条。
重要的是质量，不是接受率，也不是填得快。

分享之前要亲自检查脱敏版本。自动脱敏不等于隐私保证；启动 pipeline 前也要确认
所选模型 host 的数据处理方式。网页中的接受操作只记录审阅决定，导出后由你决定
在哪里分享。

更远的研究问题是：这些方法放到新的任务里，能不能真的帮助 agent 作出更好的决策？
这需要保留过程的先后关系，也需要跨 trajectory、skill-level 的验证。
当前的人工审阅是在建立可信的候选，不代表这项验证已经完成。

## 体验原则（第 3 项）

- 先说明贡献的实际用途，再让人开始审阅；不用虚构影响人数或收益。
- 使用现有 accepted / rejected 状态计算进度。拒绝同样计入完成，不奖励接受率。
- 提供“下一张未处理卡片”入口，保留证据变更后需重新审阅的状态。
- 把检查提示做成可展开短清单：过程顺序、迁移条件、真实结果、遗漏和隐私。
  不设置无意义的强制勾选、计时锁、隐藏注意力题或虚构分数。
- 未处理卡片、尚未应用的编辑和未完成保存不能表现成已经完成。
- 保留现有 evidence、追加修订和导出机制；不引入新的采集端点或第三方分析。

## 网页（第 5 项）

`review-app/app/contribute/page.tsx` at `/contribute`:

1. Why: keep the method behind the answer.
2. Show: an explicitly illustrative, clickable three-step session.
3. Act: choose a trajectory → review evidence → inspect and export.
4. Boundaries: human privacy check, chosen model host, intentional sharing.
5. Research direction: new-task skill evaluation, explicitly not implemented here.
6. CTA: open the existing review workspace or read setup instructions.

The review guide links here in a new tab so an invitation/story does not discard
an active review. The page does not read or display review data.

## Scope and handoffs

- Zihan: engagement prompts (3), story (4), page and review integration (5).
- Zidi: redaction (1), cross-trajectory insights (7). Page copy must track the
  actual privacy and evidence guarantees as those features evolve.
- Together: questionnaire/feedback (2), evaluation (6). The guide's questions are
  reading prompts, not collected questionnaire responses or evaluation labels.
  Agree on questionnaire content and storage separately. Skill evaluation should
  assess decisions on new tasks and preserve action order, not only match text.

## Acceptance path

- Open `/contribute` at mobile and desktop widths; all story sections and CTA
  links are usable. Selecting each example moment updates its explanation.
- Open the existing workspace. Review prompts are available without mandatory
  acknowledgements. Continue opens an unresolved card, including Evidence changed.
- Accept or decline a card: decided count changes, autosave reaches the real local
  SQLite backend, refresh restores the decision, and export retains it.
- Apply/cancel open edits before completing. Existing redaction, evidence and
  manifest completion requirements still apply.
- No production or hosted launch is claimed by this repository implementation.
  Hosted publication and real contributor feedback remain separate verification.

## Verified locally

- Existing review suite: 60 tests passed; TypeScript and production build passed.
- Chromium: story selection and review links worked; no horizontal overflow at
  375, 768, or 1440 px on either page; no browser exceptions observed.
- Using only the bundled synthetic review in the worktree's SQLite database:
  accept/decline updated progress, autosave persisted decisions across refresh,
  and `review.json` in the actual export preserved both decisions.
- The next-card shortcut and expanded checklist worked. Opening an editor
  disabled Complete. Automated browser actions waited for React hydration.
- This verifies the local path, not hosted deployment, contributor response,
  questionnaire collection, or skill performance on new tasks.
