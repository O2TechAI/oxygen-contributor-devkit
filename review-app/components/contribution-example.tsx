'use client';

import { useState } from 'react';

const moments = [
  {
    title: 'The trigger',
    text: 'A test passes locally and fails in CI.',
    label: 'A symptom, not yet a method',
    lesson:
      '“Fix the failing test” says what needs doing, but not how to investigate it.',
  },
  {
    title: 'The correction',
    text: 'The user asks the agent to compare environments before changing code.',
    label: 'The choice changes the investigation',
    lesson:
      'The correction redirects the next action: compare assumptions instead of retrying the same test.',
  },
  {
    title: 'The observation',
    text: 'The agent finds that CI uses UTC while the local test assumes a local date.',
    label: 'A recorded cause supports the method',
    lesson:
      'The useful candidate: when date-sensitive tests fail only in CI, compare timezone assumptions before changing application logic. This example identifies a cause; it does not demonstrate a successful fix.',
  },
];

export function ContributionExample() {
  const [selected, setSelected] = useState(0);
  const moment = moments[selected];
  return (
    <div className="contribute-example">
      <p className="contribute-eyebrow">
        Illustrative example · not a contributor’s session
      </p>
      <fieldset
        className="contribute-moments"
        aria-label="Follow the session in order"
      >
        {moments.map((item, index) => (
          <button
            key={item.title}
            type="button"
            aria-pressed={selected === index}
            onClick={() => setSelected(index)}
          >
            <span>0{index + 1}</span>
            <strong>{item.title}</strong>
            <span>{item.text}</span>
          </button>
        ))}
      </fieldset>
      <div className="contribute-lesson" aria-live="polite" aria-atomic="true">
        <p className="contribute-eyebrow">{moment.label}</p>
        <p>{moment.lesson}</p>
      </div>
      <p className="contribute-caption">
        Reviewer’s check: Is the sequence accurate? Does the method transfer? Is
        the outcome stated honestly?
      </p>
    </div>
  );
}
