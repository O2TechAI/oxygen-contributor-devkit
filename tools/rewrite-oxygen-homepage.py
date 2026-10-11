#!/usr/bin/env python3
"""Rewrite copy in the existing static Oxygen bundle; retain assets and animation code."""
import argparse
import hashlib
import html
import json
import re
from pathlib import Path


def rewrite(source: str, spec: dict) -> tuple[str, list[dict]]:
    pattern = r'(<script type="__bundler/template">\s*)(.*?)(\s*</script>)'
    match = re.search(pattern, source, re.S)
    if not match:
        raise ValueError('Expected one bundled page template')
    template = json.loads(match[2])
    template = template.replace('<helmet>', '<helmet><title>Oxygen — Real projects. Human judgment. Agents that learn.</title>', 1)
    report = []
    for old, new, count in spec['replacements']:
        found = template.count(old)
        if found != count:
            raise ValueError(f'Copy changed upstream: {old!r}: expected {count}, got {found}')
        template = template.replace(old, new)
        report.append({'before': old, 'after': new, 'occurrences': found})
    words = spec['animated_sentence'].split()
    sentence = ' '.join(f'<span data-t="{1 if i >= len(words) - 6 else 3 if i % 3 else 2}">{html.escape(word)}</span>' for i, word in enumerate(words))
    template, count = re.subn(r'(<p ref="\{\{ wordsRef \}\}" data-words=""[^>]*>).*?(</p>)', lambda m: m[1] + sentence + m[2], template, count=1, flags=re.S)
    if count != 1:
        raise ValueError('Missing animated sentence')
    claim = iter(spec['animated_claim'].split())
    def claim_word(m):
        return m[1] + html.escape(next(claim)) + m[2]
    template, count = re.subn(r'(<span data-cw=""[^>]*>)[^<]*(</span>)', claim_word, template)
    if count != len(spec['animated_claim'].split()):
        raise ValueError('Animated claim must preserve word count')
    # Existing metadata/section hooks remain; small typography corrections only.
    css = '''<style id="oxygen-copy-fit">
[data-noticetext] { text-align: center; }
[data-collab-scale] { display: block; }
[data-collab-domains] { display: block; margin-top: 3px; font-size: 15px; line-height: 1.25; color: #A9E3C6; }
[data-scenenote] { white-space: normal !important; text-wrap: balance; }
[data-s01line] { white-space: normal !important; text-wrap: balance; }
[data-h1] > [data-l]:last-child { max-width: 25em; text-wrap: balance; }
@media (max-width: 900px) {
  [data-notice] { top: calc(env(safe-area-inset-top) + 69px) !important; gap: 8px !important; }
  [data-noticetext] { font-size: 17px !important; line-height: 1.2 !important; }
  [data-collab-domains] { font-size: 13px; }
  [data-herotitle] { padding-top: max(calc(env(safe-area-inset-top) + 185px), 22svh) !important; }
  [data-lead] { top: max(370px, 45svh) !important; }
  [data-h1] { font-size: clamp(32px, 10vw, 58px) !important; }
}
@media (min-width: 901px) and (max-height: 400px) { [data-tall="hero"] [data-h1] { translate: 0 24px !important; } }
@media (max-width: 400px) and (max-height: 760px) { [data-filmwrap] { display: none !important; } }
@media (max-width: 1100px) and (orientation: landscape) and (max-height: 560px) {
  [data-herotitle] { padding-top: max(160px, 28svh) !important; }
  [data-h1] { font-size: clamp(28px, 5.6vw, 46px) !important; }
  [data-h1] > [data-l]:last-child { max-width: 40vw; font-size: clamp(16px, 2.5vw, 22px) !important; line-height: 1.15 !important; }
  [data-lead] { top: auto !important; }
}
</style>'''
    template = template.replace('</helmet>', css + '</helmet>', 1)
    source = source[:match.start(2)] + json.dumps(template, ensure_ascii=True).replace('</script', '<\\/script') + source[match.end(2):]
    # Remove the old catch-all mail handler, which hijacks buttons unrelated to submission.
    source, count = re.subn(r'<!-- Contact routing:.*?<script>.*?</script>', '<!-- Contribution actions use their explicit links below. -->', source, count=1, flags=re.S)
    if count != 1:
        raise ValueError('Expected old contact routing hook')
    # Keep the existing heading-fit helper aligned with the new copy.
    source = source.replace('var NEEDLE = "Local agents prepare the data";', 'var NEEDLE = "Review the lessons";')
    routing = '''<script>
(function () {
  var destinations = [
    "https://github.com/O2TechAI/oxygen-contributor-devkit#launch-the-complete-pipeline-from-codex",
    "mailto:hello@o2tech.ai?subject=Oxygen%20evaluation",
    "https://github.com/O2TechAI/oxygen-contributor-devkit"
  ];
  function route() {
    document.querySelectorAll('[data-ccard]').forEach(function (card, i) {
      if (!destinations[i]) return;
      card.setAttribute('href', destinations[i]);
      var button = card.querySelector('[data-ccta]');
      if (button) {
        button.removeAttribute('role');
        button.removeAttribute('tabindex');
        button.removeAttribute('aria-label');
      }
    });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', route);
  else route();
  new MutationObserver(route).observe(document.documentElement, {childList: true, subtree: true});
})();
</script>'''
    source, count = re.subn(r'<script>\s*\(function \(\) \{\s*var contributorKitUrl = .*?</script>', lambda m: routing, source, count=1, flags=re.S)
    if count != 1:
        raise ValueError('Expected contribution routing hook')
    source = source.replace('<title>Bundled Page</title>', '<title>Oxygen — Real projects. Human judgment. Agents that learn.</title>', 1)
    return source, report


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('source', type=Path)
    p.add_argument('output', type=Path)
    p.add_argument('--copy', type=Path, default=Path(__file__).resolve().parents[1] / 'docs/website/homepage-copy.json')
    args = p.parse_args()
    if args.source.resolve() == args.output.resolve():
        p.error('Write a separate candidate; do not overwrite the source')
    before = args.source.read_text()
    after, report = rewrite(before, json.loads(args.copy.read_text()))
    args.output.write_text(after)
    print(json.dumps({'source_sha256': hashlib.sha256(before.encode()).hexdigest(), 'output_sha256': hashlib.sha256(after.encode()).hexdigest(), 'replacement_groups': len(report)}, indent=2))


if __name__ == '__main__':
    main()
