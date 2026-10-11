import type { Metadata } from 'next';
import Link from 'next/link';
import { ContributionExample } from '@/components/contribution-example';
import './contribute.css';

export const metadata: Metadata = {
  title: 'Contribute to Oxygen — keep the lesson, not just the answer',
  description:
    'Turn the decisions and corrections inside an agent session into reusable skill candidates that you control and review.',
  openGraph: {
    title: 'Contribute to Oxygen',
    description: 'Keep the lesson, not just the answer.',
    url: '/contribute',
  },
};

export default function Contribute() {
  return (
    <main className="contribute">
      <nav aria-label="Contribution navigation" className="contribute-nav">
        <Link
          href="/contribute"
          aria-label="Oxygen contribution home"
          className="contribute-wordmark"
        >
          ✳ Oxygen
        </Link>
        <div>
          <a href="#how">How it works</a>
          <Link href="/">Open review →</Link>
        </div>
      </nav>
      <section className="contribute-hero">
        <p className="contribute-eyebrow">An invitation to contributors</p>
        <h1>
          The answer was useful.
          <br />
          <span>
            The way you got there
            <br />
            is worth keeping.
          </span>
        </h1>
        <p className="contribute-lead">
          The correction that changed an agent’s approach. The failed attempt
          that revealed a constraint. The decision you would make again. Most of
          it disappears when the session ends.
        </p>
        <p className="contribute-lead">
          Oxygen turns that work into a readable summary and reusable skill
          candidates. You bring the judgment: what happened, what matters, and
          what deserves to travel further.
        </p>
        <div className="contribute-actions">
          <Link className="contribute-button" href="/">
            Review a trajectory →
          </Link>
          <a href="#example">See one turning point ↓</a>
        </div>
        <p className="contribute-caption">
          Start with one session. Keep, edit, or decline each candidate.
        </p>
      </section>
      <section id="example" className="contribute-section">
        <div className="contribute-section-heading">
          <p className="contribute-eyebrow">
            01 / The value is in the sequence
          </p>
          <h2>
            A final answer hides
            <br />
            the important part.
          </h2>
          <p>
            A skill candidate should preserve the trigger, the choice, and the
            outcome. Follow this illustrative session to see why order matters.
          </p>
        </div>
        <ContributionExample />
      </section>
      <section id="how" className="contribute-section">
        <div className="contribute-section-heading">
          <p className="contribute-eyebrow">
            02 / A small, deliberate contribution
          </p>
          <h2>You know what the transcript leaves out.</h2>
          <p>Make one trajectory useful to someone who was not in the room.</p>
        </div>
        <ol className="contribute-steps">
          <li>
            <span>01</span>
            <h3>Choose work you understand.</h3>
            <p>
              Use the devkit with locally recorded Codex or Claude Code
              sessions. The pipeline produces a summary, skill candidates, and a
              redacted review version.
            </p>
          </li>
          <li>
            <span>02</span>
            <h3>Check the turning points.</h3>
            <p>
              Read the summary, open the cited evidence, and decide each card.
              Edit the method, attribution, or outcome if it misses what you
              learned. Decline weak cards; add a missing one.
            </p>
          </li>
          <li>
            <span>03</span>
            <h3>Review what will leave your workspace.</h3>
            <p>
              Inspect redacted content yourself. Apply edits, wait for saving,
              and export the reviewed artifacts. Check every selected version
              before sharing the files.
            </p>
          </li>
        </ol>
      </section>
      <section className="contribute-section contribute-boundaries">
        <div>
          <p className="contribute-eyebrow">
            03 / Your judgment sets the boundary
          </p>
          <h2>
            Contribute with context.
            <br />
            Share with intention.
          </h2>
        </div>
        <div className="contribute-prose">
          <h3>Redaction needs a human check.</h3>
          <p>
            Automated redaction can miss sensitive details. Review names,
            identifiers, credentials, and business context before sharing.
            Original reviews can still be opened and exported; choose redacted
            versions intentionally.
          </p>
          <h3>Review is not a sharing step.</h3>
          <p>
            Accepting a card records your review decision. Export downloads
            artifacts; you decide where to send them. The devkit pipeline sends
            selected trajectory content to model workers on your chosen host, so
            check that host’s data handling before running it.
          </p>
          <h3>A candidate is a starting point.</h3>
          <p>
            Our research direction is to test whether a skill improves decisions
            on new tasks and across trajectories. Similar wording alone cannot
            establish that. This page and the review checklist do not run
            skill-level evaluation.
          </p>
        </div>
      </section>
      <section className="contribute-closing">
        <p className="contribute-eyebrow">Keep one lesson alive</p>
        <h2>
          Bring one session.
          <br />
          Leave a method someone can use.
        </h2>
        <p>
          A precise correction is a contribution. So is a thoughtful decline.
        </p>
        <div className="contribute-actions">
          <Link className="contribute-button" href="/">
            Open the review workspace →
          </Link>
          <a href="https://github.com/O2TechAI/oxygen-contributor-devkit#launch-the-complete-pipeline-from-codex">
            Set up the devkit ↗
          </a>
        </div>
        <p className="contribute-caption">
          The workspace includes synthetic examples. Import a prepared run to
          review your own work.
        </p>
      </section>
      <footer className="contribute-footer">
        <span>Oxygen Contributor Devkit</span>
        <a href="https://github.com/O2TechAI/oxygen-contributor-devkit">
          Source & setup ↗
        </a>
      </footer>
    </main>
  );
}
