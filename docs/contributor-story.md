# Contributor story and experience — Zihan (3 / 4 / 5)

This is the copy and implementation brief for the Oxygen homepage and review
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
- Complete 旁显示 `3/3 reviewed`，保留证据变更后需重新审阅的状态。
- 首次使用打开引导，关闭后不再占据正文上方；通过 Review help 重开。
  检查提示涵盖过程顺序、迁移条件、真实结果、遗漏和隐私。
  不设置无意义的强制勾选、计时锁、隐藏注意力题或虚构分数。
- 未处理卡片、尚未应用的编辑和未完成保存不能表现成已经完成。
- 保留现有 evidence、追加修订和导出机制；不引入新的采集端点或第三方分析。

## 网页（第 5 项）

The contributor story lives on the [Oxygen homepage](https://oxygen.o2tech.ai/).
The first-use Review help panel links there in a new tab so opening it does not
discard an active review. Source and protocol details live in Page information.

## Scope and handoffs

- Zihan: engagement prompts (3), story (4), page and review integration (5).
- Zidi: redaction (1), cross-trajectory insights (7). Page copy must track the
  actual privacy and evidence guarantees as those features evolve.
- Together: questionnaire/feedback (2), evaluation (6). The guide's questions are
  reading prompts, not collected questionnaire responses or evaluation labels.
  Agree on questionnaire content and storage separately. Skill evaluation should
  assess decisions on new tasks and preserve action order, not only match text.

## Acceptance path

- Open the Why contribute link from Review help; it opens the Oxygen homepage
  in a new tab and leaves the active review open.
- Open the existing workspace. First-use help can be dismissed and reopened;
  refreshing remembers dismissal. Progress beside Complete counts accepted and
  declined cards only; Evidence changed cards still require review.
- Accept or decline a card: decided count changes, autosave reaches the real local
  SQLite backend, refresh restores the decision, and export retains it.
- Apply/cancel open edits before completing. Existing redaction, evidence and
  manifest completion requirements still apply.
- No production or hosted launch is claimed by this repository implementation.
  Hosted publication and real contributor feedback remain separate verification.

## Verified locally

- Existing review suite plus the source-label regression check: 61 tests passed; TypeScript and production build passed.
- Using only the bundled synthetic review in the worktree's SQLite database:
  accept/decline updated progress, autosave persisted decisions across refresh,
  and `review.json` in the actual export preserved both decisions.
- The earlier next-card shortcut and expanded checklist worked. The compact
  layout now uses first-use help with remembered dismissal and a Page information
  panel. Chromium verified both panels, plain Takeaway prose, compact progress,
  persistence after refresh, and 375/768/1440 px layouts. Opening an editor
  disabled Complete. Automated browser actions waited for React hydration.
- This verifies the local path, not hosted deployment, contributor response,
  questionnaire collection, or skill performance on new tasks.

## Live homepage copy — oxygen.o2tech.ai

Target: <https://oxygen.o2tech.ai/>. This section is replacement copy for the
live research homepage. The devkit links directly to this homepage.
The live page was read in Chromium. Its source/deployment is not configured in
this checkout; the text below has not been published.

### Editorial changes

| Current wording | Replace with / reason |
| --- | --- |
| Human experience is the next scaling law. | Help AI agents learn from real work. Explain the project before introducing a research thesis. |
| The project is the learning signal. | A project records what people tried, corrected, and learned. |
| Your agent only learns 10% of your project signal. | Remove the percentage until a cited measurement supports it. |
| The first benchmark for personalized continual learning… | Explain what is collected and tested; remove the priority claim unless supported. |
| Trajectory | Project history on navigation; define trajectory once in research detail. |
| Ground truth / externalize / no-context control | Contributor-written lessons / report what it learned / score without project history. Keep technical terms in scoring details. |
| Bring your trajectory. Build the forest. | Contribute a project. Help test what agents learn. |

Do not say the current benchmark measures changed behavior while the visible
scoring section only describes matching extracted lessons. Separate the current
measurement from the planned new-task skill evaluation.

### Release notice

Preview: we’re preparing Oxygen v0.1.

Remove “within the next week” unless the team maintains a confirmed release date.
Preserve the existing navigation destinations, with readable labels:
Overview · Project histories · Evaluation · Results · Contribute.

### Hero

**Help AI agents learn from real work.**

Oxygen is a research project that collects how people and AI agents work together:
what they tried, what people corrected, and what happened next.
We use these project histories to test what an agent can learn from experience.

Primary action: **Explore a project**
Secondary action: **Contribute a project**

### Why project history matters

**The final result leaves out many of the lessons.**

A finished project shows what was built. Its history also shows why an approach
failed, how a person redirected the agent, and which constraints changed the plan.
Those decisions can be useful in future work.

Illustrative example:
A test passes locally but fails in CI. The user asks the agent to compare the
environments before changing code. The agent discovers a timezone mismatch.
The reusable lesson is to check environment differences when a failure only
appears in CI. The order matters: the correction changes what the agent does next.

This is an example, not a reported Oxygen evaluation result.

### What Oxygen collects

**Projects, with the decisions kept in order.**

We are building a dataset of human–agent project histories. A history can include
agent conversations, human feedback, decisions, attempts, and outcomes.
Meeting notes and other project records can add context when available.

Each reviewed contribution pairs the project history with lessons checked by
someone who understands the work. The devkit currently supports recorded Codex
and Claude Code sessions; other project material should not be presented as a
supported automatic import without a verified collection path.

### How to contribute

**Start with one project you know well.**

1. **Prepare the records.** Use the devkit with supported sessions from your project.
2. **Check the summary and lessons.** Correct mistakes, decline weak candidates,
   and add important missing context. Preserve the order of attempts and feedback.
3. **Check sensitive information.** Review the redacted files yourself before sharing.
4. **Export your reviewed contribution.** Export produces files; it does not submit
   them to the Oxygen team. Use the team’s actual submission channel when available.

Automated redaction can miss details. The preparation workflow uses model workers
on your chosen host; check its data handling before processing private records.
Replace “Nothing is uploaded until…” with this description of the actual boundary.

Primary action: **Open the contributor guide**

### How evaluation works

**What can an agent learn from a project?**

The current evaluation described on this site has three steps:

1. **Read the project history.** A learning method receives the records, but not
   the contributor-written reference lessons.
2. **Report what it learned.** Every method is asked for its reusable lessons in
   the same format, including when each lesson applies.
3. **Compare the lessons.** We compare its answers with the contributor-written
   references and with answers produced without the project history.

This checks whether a method recovers the recorded lessons. It does not yet show
that the method can apply those lessons successfully to a new task.
Our next evaluation goal is to test that application, including skills that depend
on several decisions or corrections happening in sequence.

Expandable scoring detail:
Precision asks how many reported lessons are supported by the references.
Recall asks how many reference lessons were recovered. F1 combines the two.
The “without project history” comparison helps identify what the model already
knows. Confirm the matching rules with the evaluation team before publication.

### Results

**Evaluation results will appear here.**

The current table contains method names with pending scores. Show “Not yet
reported” for those entries and avoid presenting the table as a performance ranking.
When results are available, show the score with and without project history together.

### Ways to help

**Contribute your experience. Test your method. Build the tools.**

- **Contribute a project.** Review a project history and help us capture its useful
  lessons accurately. Start with work you understand.
- **Test a learning method.** Compare what it learns from project records with
  lessons checked by the people who did the work.
- **Build the tools.** Help improve collection, redaction, review, and evaluation.

Closing:
**Help keep the decisions behind the work.**
Your corrections and failed attempts contain lessons a final answer cannot show.
Start with one project and help us make those lessons useful for future agents.

Actions: **Contribute a project** · **Contact the team**.
Keep working destinations; do not add an upload button without an actual submission path.
