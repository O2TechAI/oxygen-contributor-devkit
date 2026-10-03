'use client';

import {
  type ReactNode,
  type SyntheticEvent,
  useEffect,
  useMemo,
  useState,
} from 'react';
import {
  AlertTriangle,
  Check,
  Download,
  FilePlus2,
  FileText,
  Lightbulb,
  List,
  LogOut,
  PencilLine,
  Plus,
  ShieldCheck,
  Sparkles,
  Trash2,
  X,
} from 'lucide-react';

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ScrollArea } from '@/components/ui/scroll-area';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { Textarea } from '@/components/ui/textarea';
import { RichSummary } from '@/components/rich-summary';
import { InsightTakeaway, InsightProse } from '@/components/insight-takeaway';
import { ImportReview } from '@/components/import-review';
import { TrajectoryPanel } from '@/components/trajectory-panel';
import { ExportLabelingWarning } from '@/components/export-labeling-warning';
import { exportLabelingSummary } from '@/lib/export-labeling';
import {
  defaultReviewSelection,
  groupTrajectories,
  trajectoryIdentity,
} from '@/lib/trajectory-list';
import {
  reviewerInsightExample,
  reviewerInsightPromptPath,
  parseReviewerInsight,
  reviewerInsightDraft,
} from '@/lib/reviewer-insight';
import { reviewLabels } from '@/lib/review-label';
import {
  insightKeysForProtocol,
  insightTypesForProtocol,
  isSkillCandidateProtocol,
  hasWorkflowField,
  type Insight,
  type InsightKey,
  type InsightStatus,
  type Review,
  type SummaryLine,
} from '@/lib/review-types';
import { cn } from '@/lib/utils';
import {
  classifySummaryLines,
  detectedInsightKeys,
  relabelSummaryLines,
  remapInsightEvidence,
  summaryMarkdown,
} from '@/lib/v5-format';

type ItemKind = 'trajectory' | 'group' | 'summary' | 'insight';
type EditorTarget = {
  kind: ItemKind;
  id: string;
  mode: 'add' | 'edit';
} | null;
type DeleteTarget = { kind: 'summary' | 'insight'; id: string } | null;

function reviewStatusLabel(status: Review['status']) {
  if (status === 'completed') return 'Completed';
  if (status === 'in_review') return 'In review';
  return 'Ready';
}

function insightStatusLabel(status: InsightStatus) {
  if (status === 'accepted') return 'Accepted';
  if (status === 'rejected') return 'Declined';
  if (status === 'needs_review') return 'Evidence changed';
  return 'Pending';
}

function nextItemId(ids: string[], prefix: 'L' | 'I') {
  const highest = ids.reduce((maximum, id) => {
    const value = Number(id.slice(1));
    return Number.isFinite(value) ? Math.max(maximum, value) : maximum;
  }, 0);
  return `${prefix}${String(highest + 1).padStart(3, '0')}`;
}

function reviewIsCompletable(review: Review) {
  if (review.format !== 'v5') return true;
  return (
    review.privacyStatus === 'redacted' &&
    review.provenance.hashVerified &&
    review.insights.every(
      (insight) =>
        insight.status === 'accepted' || insight.status === 'rejected',
    )
  );
}

export default function Home() {
  const [authState, setAuthState] = useState<
    'checking' | 'signed_out' | 'signed_in'
  >('checking');
  const [username, setUsername] = useState('Oxygen');
  const [password, setPassword] = useState('');
  const [loginError, setLoginError] = useState('');
  const [loginPending, setLoginPending] = useState(false);
  const [reviews, setReviews] = useState<Review[]>([]);
  const [reviewsLoaded, setReviewsLoaded] = useState(false);
  const [activeId, setActiveId] = useState('');
  const [selectedInsight, setSelectedInsight] = useState('');
  const [editorTarget, setEditorTarget] = useState<EditorTarget>(null);
  const [deleteTarget, setDeleteTarget] = useState<DeleteTarget>(null);
  const [draftText, setDraftText] = useState('');
  const [draftTitle, setDraftTitle] = useState('');
  const [draftType, setDraftType] = useState('');
  const [draftAppliesWhen, setDraftAppliesWhen] = useState('');
  const [draftScope, setDraftScope] = useState('');
  const [draftTakeaway, setDraftTakeaway] = useState('');
  const [draftDescription, setDraftDescription] = useState('');
  const [draftWorkflow, setDraftWorkflow] = useState('');
  const [draftExample, setDraftExample] = useState('');
  const [draftWhy, setDraftWhy] = useState('');
  const [draftEvidence, setDraftEvidence] = useState('');
  const [changeNote, setChangeNote] = useState('');
  const [editorError, setEditorError] = useState('');
  const [pendingNotes, setPendingNotes] = useState<string[]>([]);
  const [dirty, setDirty] = useState(false);
  const [saveState, setSaveState] = useState<
    'idle' | 'saving' | 'saved' | 'error'
  >('idle');
  const [saveError, setSaveError] = useState('');
  const [showPreview, setShowPreview] = useState(false);
  const [promptFeedback, setPromptFeedback] = useState('');
  const [batchExportOpen, setBatchExportOpen] = useState(false);
  const [exportIds, setExportIds] = useState<string[]>([]);
  const [exportWarningOpen, setExportWarningOpen] = useState(false);

  const active = reviews.find((review) => review.id === activeId) ?? reviews[0];
  const skillCandidates = isSkillCandidateProtocol(
    active?.protocolVersion ?? 7,
  );
  const workflowField = hasWorkflowField(active?.protocolVersion ?? 7);
  const insightTypes = insightTypesForProtocol(active?.protocolVersion ?? 7);
  const labels = useMemo(() => reviewLabels(reviews), [reviews]);
  const markdownEditor =
    editorTarget?.kind === 'insight' &&
    (editorTarget.mode === 'add' ||
      active?.insights.find((item) => item.id === editorTarget.id)
        ?.authorship === 'reviewer');
  let preview: Insight | undefined;
  let previewError = '';
  if (markdownEditor && showPreview && active && editorTarget) {
    try {
      preview = parseReviewerInsight(
        editorTarget.id,
        draftText,
        active.summaryLines,
        active.protocolVersion,
      );
    } catch (error) {
      previewError =
        error instanceof Error ? error.message : 'Invalid insight Markdown.';
    }
  }
  const selected =
    active?.insights.find((insight) => insight.id === selectedInsight) ??
    active?.insights[0];
  const evidence = useMemo(() => new Set(selected?.evidence ?? []), [selected]);
  const referencesToDelete =
    deleteTarget?.kind === 'summary'
      ? (active?.insights.filter((insight) =>
          insight.evidence.includes(deleteTarget.id),
        ).length ?? 0)
      : 0;

  useEffect(() => {
    let cancelled = false;
    fetch('/api/auth/session', { cache: 'no-store' })
      .then(async (response) => {
        if (!response.ok) throw new Error('Unable to check session.');
        return response.json() as Promise<{ authenticated: boolean }>;
      })
      .then(({ authenticated }) => {
        if (!cancelled) {
          setAuthState(authenticated ? 'signed_in' : 'signed_out');
        }
      })
      .catch(() => {
        if (!cancelled) {
          setLoginError('Unable to check the login session.');
          setAuthState('signed_out');
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (authState !== 'signed_in') return;
    let cancelled = false;
    fetch('/api/reviews', { cache: 'no-store' })
      .then(async (response) => {
        if (response.status === 401) {
          setAuthState('signed_out');
          throw new Error('Authentication required.');
        }
        if (!response.ok) throw new Error('Unable to load reviews.');
        return response.json() as Promise<{ reviews: Review[] }>;
      })
      .then(({ reviews: loaded }) => {
        if (cancelled) return;
        setReviews(loaded);
        setReviewsLoaded(true);
        if (loaded.length) {
          const requestedId = new URLSearchParams(window.location.search).get(
            'review',
          );
          const requested = loaded.find((review) => review.id === requestedId);
          const fallback = requested ?? loaded[0];
          setActiveId((current) =>
            loaded.some((review) => review.id === current)
              ? current
              : fallback.id,
          );
          const parameters = new URLSearchParams(window.location.search);
          const run =
            parameters.get('run') ??
            trajectoryIdentity(fallback.sourcePath, fallback.id).run;
          setExportIds(defaultReviewSelection(loaded, run));
          if (parameters.get('trajectories') === '1') {
            setBatchExportOpen(true);
          }
          setSelectedInsight((current) =>
            loaded.some((review) =>
              review.insights.some((insight) => insight.id === current),
            )
              ? current
              : (fallback.insights[0]?.id ?? ''),
          );
        }
      })
      .catch((error) => {
        if (!cancelled) {
          setReviewsLoaded(true);
          setSaveError(
            error instanceof Error ? error.message : 'Unable to load reviews.',
          );
          setSaveState('error');
        }
      });
    return () => {
      cancelled = true;
    };
  }, [authState]);

  async function handleLogin(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    setLoginPending(true);
    setLoginError('');
    try {
      const response = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username, password }),
      });
      if (!response.ok) {
        const result = (await response.json().catch(() => null)) as {
          error?: string;
        } | null;
        throw new Error(result?.error || 'Unable to sign in.');
      }
      setPassword('');
      setAuthState('signed_in');
    } catch (error) {
      setLoginError(
        error instanceof Error ? error.message : 'Unable to sign in.',
      );
    } finally {
      setLoginPending(false);
    }
  }

  async function handleLogout() {
    await fetch('/api/auth/logout', { method: 'POST' }).catch(() => null);
    setReviews([]);
    setExportIds([]);
    setReviewsLoaded(false);
    setActiveId('');
    setSelectedInsight('');
    setPassword('');
    setAuthState('signed_out');
  }

  function chooseReview(id: string) {
    const review = reviews.find((item) => item.id === id);
    if (!review) return;
    activateReview(review);
  }

  function openImportedReview(review: Review) {
    setReviews((current) => [review, ...current]);
    activateReview(review);
  }

  function activateReview(review: Review) {
    setActiveId(review.id);
    const url = new URL(window.location.href);
    url.searchParams.set('review', review.id);
    window.history.replaceState(null, '', url);
    setSelectedInsight(review.insights[0]?.id ?? '');
    setPendingNotes([]);
    setDirty(false);
    setSaveState('idle');
    setSaveError('');
  }

  function updateActive(transform: (review: Review) => Review, note: string) {
    if (!active) return;
    setReviews((current) =>
      current.map((review) =>
        review.id === active.id ? transform(review) : review,
      ),
    );
    setPendingNotes((current) => [...current, note]);
    setDirty(true);
    setSaveState('idle');
    setSaveError('');
  }

  function resetDraft() {
    setDraftText('');
    setDraftTitle('');
    setDraftType('');
    setDraftAppliesWhen('');
    setDraftScope('');
    setDraftTakeaway('');
    setDraftDescription('');
    setDraftWorkflow('');
    setDraftExample('');
    setDraftWhy('');
    setDraftEvidence('');
    setChangeNote('');
    setEditorError('');
    setShowPreview(false);
    setPromptFeedback('');
  }

  function openEditor(kind: ItemKind, id: string) {
    if (!active) return;
    resetDraft();
    if (kind === 'trajectory') {
      setDraftText(active.trajectorySummary.text);
    } else if (kind === 'group') {
      const group = active.summaryGroups.find((item) => item.id === id);
      if (!group) return;
      setDraftText(group.text);
    } else if (kind === 'summary') {
      const line = active.summaryLines.find((item) => item.id === id);
      if (!line) return;
      setDraftText(line.text);
    } else {
      const insight = active.insights.find((item) => item.id === id);
      if (!insight) return;
      setDraftText(
        insight.authorship === 'reviewer'
          ? reviewerInsightDraft(insight, active.protocolVersion)
          : insight.text,
      );
      setDraftTitle(insight.title);
      setDraftType(insight.type ?? insightTypes[0]);
      setDraftAppliesWhen(insight.appliesWhen ?? '');
      setDraftScope(insight.scope ?? '');
      setDraftTakeaway(insight.takeaway ?? '');
      setDraftDescription(insight.description ?? '');
      setDraftWorkflow(insight.workflow ?? '');
      setDraftExample(insight.example ?? '');
      setDraftWhy(insight.why ?? '');
      setDraftEvidence(insight.evidence.join(', '));
    }
    setEditorTarget({ kind, id, mode: 'edit' });
  }

  function openCreate(kind: 'summary' | 'insight') {
    if (!active) return;
    resetDraft();
    const id =
      kind === 'summary'
        ? nextItemId(
            active.summaryLines.map((line) => line.id),
            'L',
          )
        : nextItemId(
            active.insights.map((insight) => insight.id),
            'I',
          );
    setEditorTarget({ kind, id, mode: 'add' });
  }

  function parsedEvidence() {
    if (!active) return [];
    const allowedLines = new Set(
      active.summaryLines
        .filter((line) => active.format !== 'v5' || line.kind === 'content')
        .map((line) => line.id),
    );
    const requested = draftEvidence
      .split(',')
      .map((value) => value.trim().toUpperCase())
      .filter(Boolean);
    if (
      new Set(requested).size !== requested.length ||
      requested.some((value) => !allowedLines.has(value))
    ) {
      throw new Error(
        'Evidence must contain unique, substantive Summary line IDs.',
      );
    }
    return requested;
  }

  function applyEditor() {
    if (!active || !editorTarget) return;
    setEditorError('');
    const action = editorTarget.mode === 'add' ? 'Added' : 'Edited';
    const note = changeNote.trim() || `${action} ${editorTarget.id}`;

    if (markdownEditor) {
      try {
        const card = parseReviewerInsight(
          editorTarget.id,
          draftText,
          active.summaryLines,
          active.protocolVersion,
        );
        updateActive(
          (review) => ({
            ...review,
            insights:
              editorTarget.mode === 'add'
                ? [
                    ...review.insights,
                    { ...card, sourceId: crypto.randomUUID() },
                  ]
                : review.insights.map((item) =>
                    item.id === card.id
                      ? {
                          ...card,
                          sourceId: item.sourceId,
                          originalText: item.originalText,
                        }
                      : item,
                  ),
          }),
          note,
        );
        setSelectedInsight(card.id);
        setEditorTarget(null);
      } catch (error) {
        setEditorError(
          error instanceof Error ? error.message : 'Invalid insight Markdown.',
        );
      }
      return;
    }

    if (
      editorTarget.kind !== 'insight' &&
      (!draftText.trim() || /[\r\n]/.test(draftText))
    ) {
      setEditorError('A Summary line must contain one physical line.');
      return;
    }

    if (
      editorTarget.kind === 'insight' &&
      skillCandidates &&
      (!draftTitle.trim() ||
        !insightTypes.includes(draftType) ||
        !draftDescription.trim() ||
        (workflowField && !draftWorkflow.trim()) ||
        !draftExample.trim())
    ) {
      setEditorError(
        `Include a Title, origin Type, Description, ${workflowField ? 'Workflow, ' : ''}and Example.`,
      );
      return;
    }
    let nextEvidence: string[] = [];
    if (editorTarget.kind === 'insight') {
      try {
        nextEvidence = parsedEvidence();
      } catch (error) {
        setEditorError(
          error instanceof Error ? error.message : 'Invalid Evidence.',
        );
        return;
      }
      if (active.format === 'v5' && !draftTitle.trim()) {
        setEditorError('Insight title is required for review.');
        return;
      }
      if (active.format !== 'v5' && !draftText.trim()) {
        setEditorError('Insight text is required.');
        return;
      }
    }

    updateActive((review) => {
      if (editorTarget.kind === 'trajectory') {
        return {
          ...review,
          trajectorySummary: {
            ...review.trajectorySummary,
            text: draftText.trim(),
          },
        };
      }
      if (editorTarget.kind === 'group') {
        return {
          ...review,
          summaryGroups: review.summaryGroups.map((group) =>
            group.id === editorTarget.id
              ? { ...group, text: draftText.trim() }
              : group,
          ),
        };
      }
      if (editorTarget.kind === 'summary') {
        if (editorTarget.mode === 'add') {
          const parsed = classifySummaryLines(`${draftText}\n`)[0];
          const existingLines =
            review.format === 'v5'
              ? review.summaryLines.map((line, index, lines) =>
                  index === lines.length - 1 && line.ending === ''
                    ? { ...line, ending: '\n' as const }
                    : line,
                )
              : review.summaryLines;
          return {
            ...review,
            summaryGroups:
              review.format === 'legacy'
                ? review.summaryGroups.map((group, index, groups) =>
                    index === groups.length - 1
                      ? {
                          ...group,
                          lineIds: [...group.lineIds, editorTarget.id],
                        }
                      : group,
                  )
                : review.summaryGroups,
            summaryLines: [
              ...existingLines,
              {
                ...parsed,
                id: editorTarget.id,
                sourceId: undefined,
                originalText: '',
              },
            ],
          };
        }
        const cited = review.insights.some((insight) =>
          insight.evidence.includes(editorTarget.id),
        );
        const parsed = classifySummaryLines(`${draftText}\n`)[0];
        return {
          ...review,
          summaryLines: review.summaryLines.map((line) =>
            line.id === editorTarget.id
              ? {
                  ...line,
                  text: draftText,
                  kind: parsed.kind,
                }
              : line,
          ),
          insights: cited
            ? review.insights.map((insight) =>
                insight.evidence.includes(editorTarget.id) &&
                insight.status !== 'rejected'
                  ? { ...insight, status: 'needs_review' }
                  : insight,
              )
            : review.insights,
        };
      }

      const fields = {
        appliesWhen: draftAppliesWhen.trim(),
        scope: draftScope.trim(),
        takeaway: draftTakeaway.trim(),
        description: draftDescription.trim(),
        workflow: draftWorkflow.trim(),
        example: draftExample.trim(),
        why: draftWhy.trim(),
      };
      const presentKeys = insightKeysForProtocol(review.protocolVersion).filter(
        (key) => {
          if (key === 'title') return Boolean(draftTitle.trim());
          if (key === 'type') return Boolean(draftType.trim());
          if (key === 'scope') return Boolean(fields.scope);
          if (key === 'takeaway') return Boolean(fields.takeaway);
          if (key === 'description') return Boolean(fields.description);
          if (key === 'workflow') return Boolean(fields.workflow);
          if (key === 'example') return Boolean(fields.example);
          return (
            isSkillCandidateProtocol(review.protocolVersion) ||
            nextEvidence.length > 0
          );
        },
      );
      const value: Insight = {
        id: editorTarget.id,
        sourceId: undefined,
        title: draftTitle.trim() || 'Untitled insight',
        presentKeys: review.format === 'v5' ? presentKeys : undefined,
        type:
          review.format === 'v5' ? draftType.trim() || undefined : undefined,
        appliesWhen:
          review.format === 'v5' ? fields.appliesWhen || undefined : undefined,
        scope: review.format === 'v5' ? fields.scope || undefined : undefined,
        takeaway:
          review.format === 'v5' ? fields.takeaway || undefined : undefined,
        why: review.format === 'v5' ? fields.why || undefined : undefined,
        description: isSkillCandidateProtocol(review.protocolVersion)
          ? fields.description
          : undefined,
        workflow: hasWorkflowField(review.protocolVersion)
          ? fields.workflow
          : undefined,
        example: isSkillCandidateProtocol(review.protocolVersion)
          ? fields.example
          : undefined,
        originalText: '',
        text: draftText.trim(),
        evidence: nextEvidence,
        status: nextEvidence.length ? 'pending' : 'needs_review',
      };
      if (editorTarget.mode === 'add') {
        return { ...review, insights: [...review.insights, value] };
      }
      return {
        ...review,
        insights: review.insights.map((insight) =>
          insight.id === editorTarget.id
            ? {
                ...value,
                sourceId: insight.sourceId,
                authorship: insight.authorship,
                originalText: insight.originalText,
              }
            : insight,
        ),
      };
    }, note);

    if (editorTarget.kind === 'insight') {
      setSelectedInsight(editorTarget.id);
    }
    setEditorTarget(null);
  }

  function confirmDelete() {
    if (!active || !deleteTarget) return;
    const target = deleteTarget;
    updateActive((review) => {
      if (target.kind === 'summary') {
        if (review.format === 'v5') {
          const remaining = review.summaryLines.filter(
            (line) => line.id !== target.id,
          );
          const relabeled = relabelSummaryLines(remaining);
          return {
            ...review,
            summaryLines: relabeled.lines,
            insights: remapInsightEvidence(
              review.insights,
              relabeled.idMap,
              new Set([target.id]),
            ),
          };
        }
        return {
          ...review,
          summaryGroups: review.summaryGroups
            .map((group) => ({
              ...group,
              lineIds: group.lineIds.filter((id) => id !== target.id),
            }))
            .filter((group) => group.lineIds.length),
          summaryLines: review.summaryLines.filter(
            (line) => line.id !== target.id,
          ),
          insights: review.insights.map((insight) => ({
            ...insight,
            evidence: insight.evidence.filter((id) => id !== target.id),
          })),
        };
      }
      const insights = review.insights
        .filter((insight) => insight.id !== target.id)
        .map((insight, index) =>
          review.format === 'v5'
            ? {
                ...insight,
                sourceId: insight.sourceId ?? insight.id,
                id: `I${String(index + 1).padStart(3, '0')}`,
              }
            : insight,
        );
      if (selectedInsight === target.id) {
        setSelectedInsight(insights[0]?.id ?? '');
      }
      return { ...review, insights };
    }, `Removed ${target.id}`);
    setDeleteTarget(null);
  }

  function setInsightStatus(id: string, status: InsightStatus) {
    updateActive(
      (review) => ({
        ...review,
        insights: review.insights.map((insight) =>
          insight.id === id ? { ...insight, status } : insight,
        ),
      }),
      `${insightStatusLabel(status)} ${id}`,
    );
  }

  function jumpToEvidence(insightId: string, lineId: string) {
    setSelectedInsight(insightId);
    window.setTimeout(() => {
      const target =
        document.querySelector<HTMLElement>(
          `[data-summary-lines~="${lineId}"]`,
        ) ?? document.getElementById(lineId);
      target?.scrollIntoView({
        behavior: 'smooth',
        block: 'center',
      });
    }, 0);
  }

  function openBatchExport() {
    setBatchExportOpen(true);
  }

  function downloadActiveReview() {
    if (!active || dirty || saveState === 'saving' || editorTarget !== null)
      return;
    const link = document.createElement('a');
    link.href = `/api/reviews/${active.id}/export`;
    link.download = '';
    document.body.appendChild(link);
    link.click();
    link.remove();
  }

  async function persist(status: Review['status']) {
    if (!active) return;
    setSaveState('saving');
    setSaveError('');
    try {
      const response = await fetch(`/api/reviews/${active.id}/revisions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          trajectorySummary: active.trajectorySummary,
          summaryGroups: active.summaryGroups,
          summaryLines: active.summaryLines,
          insights: active.insights,
          note:
            pendingNotes.join('; ') ||
            (status === 'completed'
              ? 'Human review completed.'
              : 'Review draft saved.'),
          status,
        }),
      });
      if (!response.ok) {
        const result = (await response.json().catch(() => null)) as {
          error?: string;
        } | null;
        throw new Error(result?.error || 'Save failed.');
      }
      const { review } = (await response.json()) as { review: Review };
      setReviews((current) =>
        current.map((item) => (item.id === review.id ? review : item)),
      );
      setPendingNotes([]);
      setDirty(false);
      setSaveState('saved');
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : 'Save failed.');
      setSaveState('error');
    }
  }

  if (authState === 'checking') {
    return <CenteredMessage label="Checking access…" />;
  }

  if (authState === 'signed_out') {
    return (
      <main className="grid min-h-screen place-items-center bg-background px-6 py-12 text-foreground">
        <section className="w-full max-w-sm rounded-lg border bg-card p-7 shadow-sm">
          <span className="grid size-11 place-items-center rounded-lg bg-primary text-primary-foreground">
            <Sparkles className="size-5" />
          </span>
          <h1 className="mt-6 text-2xl font-semibold">Oxygen Review</h1>
          <p className="mt-2 text-sm leading-6 text-muted-foreground">
            Sign in to review generated Summary and Insight cards.
          </p>
          <form className="mt-7 space-y-4" onSubmit={handleLogin}>
            <label className="block space-y-2" htmlFor="login-username">
              <span className="text-xs font-semibold uppercase text-muted-foreground">
                Account
              </span>
              <Input
                id="login-username"
                autoComplete="username"
                value={username}
                onChange={(event) => setUsername(event.target.value)}
                required
              />
            </label>
            <label className="block space-y-2" htmlFor="login-password">
              <span className="text-xs font-semibold uppercase text-muted-foreground">
                Password
              </span>
              <Input
                id="login-password"
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                required
              />
            </label>
            {loginError && (
              <p role="alert" className="text-sm text-destructive">
                {loginError}
              </p>
            )}
            <Button className="w-full" type="submit" disabled={loginPending}>
              {loginPending ? 'Signing in…' : 'Sign in'}
            </Button>
          </form>
        </section>
      </main>
    );
  }

  if (!reviewsLoaded) return <CenteredMessage label="Loading reviews…" />;

  if (!active) {
    return (
      <main className="grid min-h-screen place-items-center bg-background px-6 text-foreground">
        <div className="text-center">
          <FilePlus2 className="mx-auto size-8 text-muted-foreground" />
          <h1 className="mt-4 text-lg font-semibold">No reviews waiting</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            Verified Oxygen runs will appear here after publication.
          </p>
          {saveError && (
            <p className="mt-3 text-sm text-destructive">{saveError}</p>
          )}
          <div className="mt-5 flex justify-center gap-2">
            <ImportReview onImported={openImportedReview} />
            <Button variant="outline" onClick={handleLogout}>
              <LogOut data-icon="inline-start" />
              Sign out
            </Button>
          </div>
        </div>
      </main>
    );
  }

  const completable = reviewIsCompletable(active);
  const unresolved = active.insights.filter(
    (insight) => insight.status !== 'accepted' && insight.status !== 'rejected',
  ).length;

  return (
    <main className="min-h-screen bg-background text-foreground">
      <TrajectoryPanel
        reviews={reviews}
        active={active}
        open={batchExportOpen}
        onOpenChange={setBatchExportOpen}
        selectedIds={exportIds}
        setSelectedIds={setExportIds}
        onOpenReview={chooseReview}
        unsaved={dirty || saveState === 'saving' || editorTarget !== null}
      />
      <ExportLabelingWarning
        reviews={[active]}
        open={exportWarningOpen}
        onOpenChange={setExportWarningOpen}
        onConfirm={downloadActiveReview}
      />
      <header className="flex min-h-16 flex-wrap items-center justify-between gap-3 border-b bg-card px-4 py-3 sm:px-6">
        <div className="flex min-w-0 flex-wrap items-center gap-3">
          <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-primary text-primary-foreground">
            <Sparkles className="size-4" />
          </span>
          <div>
            <p className="text-sm font-semibold leading-none">Oxygen Review</p>
            <p className="mt-1 text-xs text-muted-foreground">
              Human approval workspace
            </p>
          </div>
          <select
            aria-label="Choose trajectory review"
            value={active.id}
            onChange={(event) => chooseReview(event.target.value)}
            title={labels.get(active.id)}
            className="h-9 max-w-[min(90vw,40rem)] rounded-md border bg-background px-3 text-sm font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {reviews.map((review) => (
              <option key={review.id} value={review.id}>
                {labels.get(review.id)}
              </option>
            ))}
          </select>
          <Badge variant="secondary">{reviewStatusLabel(active.status)}</Badge>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <ImportReview
            disabled={dirty || saveState === 'saving' || editorTarget !== null}
            onImported={openImportedReview}
          />
          <span
            className={cn(
              'hidden max-w-64 truncate text-xs sm:inline',
              saveState === 'error'
                ? 'text-destructive'
                : 'text-muted-foreground',
            )}
            title={saveError}
          >
            {saveState === 'saving'
              ? 'Saving…'
              : saveState === 'saved'
                ? `Saved · revision ${active.revisionCount}`
                : saveState === 'error'
                  ? saveError || 'Could not save'
                  : dirty
                    ? 'Unsaved changes'
                    : `Revision ${active.revisionCount}`}
          </span>
          <Button
            variant="ghost"
            disabled={dirty || saveState === 'saving' || editorTarget !== null}
            title={
              dirty || editorTarget
                ? 'Apply and save your edits before exporting'
                : 'Export the latest saved summary and insight decisions'
            }
            aria-label="Export reviewed artifacts"
            onClick={() => {
              if (exportLabelingSummary([active]).incompleteReviews > 0)
                setExportWarningOpen(true);
              else downloadActiveReview();
            }}
          >
            <Download data-icon="inline-start" />
            Export
          </Button>
          <Button variant="outline" onClick={openBatchExport}>
            <List data-icon="inline-start" />
            Trajectories ({groupTrajectories(reviews).length})
          </Button>
          <Button
            variant="outline"
            disabled={saveState === 'saving' || !dirty}
            onClick={() => persist('in_review')}
          >
            Save
          </Button>
          <Button
            disabled={saveState === 'saving' || !completable}
            title={
              completable
                ? 'Complete review'
                : 'Complete a redacted review after resolving every Insight'
            }
            onClick={() => persist('completed')}
          >
            <Check data-icon="inline-start" />
            Complete
          </Button>
          <Button variant="ghost" onClick={handleLogout}>
            <LogOut data-icon="inline-start" />
            Sign out
          </Button>
        </div>
      </header>

      <div className="border-b px-4 py-3 text-sm sm:px-6">
        <p className="font-medium">
          Would this insight help you with future work on this project or
          another?
        </p>
        <p className="mt-1 text-muted-foreground">
          Accept useful, accurate guidance; edit what needs correction; reject
          unsupported or unhelpful cards. You can add a missing insight from
          your own experience.
        </p>
        {workflowField && (
          <p className="mt-1 text-muted-foreground">
            Description: what the skill does and when to use it. Workflow: the
            reusable method. Example: how it was applied in a recorded case,
            with the actual outcome made clear.
          </p>
        )}
        <p className="mt-1 break-all text-xs text-muted-foreground">
          {active.projectName} · {active.sourcePath}
        </p>
      </div>
      {active.format === 'v5' && (
        <section className="flex flex-wrap items-center gap-x-5 gap-y-2 border-b bg-muted/25 px-4 py-3 text-xs sm:px-6">
          <span className="font-semibold">
            Protocol v{active.protocolVersion}
          </span>
          <span className="capitalize">{active.stage} stage</span>
          <span
            className={cn(
              'inline-flex items-center gap-1.5 font-medium',
              active.privacyStatus === 'redacted'
                ? 'text-[color:var(--evidence-strong)]'
                : 'text-destructive',
            )}
          >
            {active.privacyStatus === 'redacted' ? (
              <ShieldCheck className="size-3.5" />
            ) : (
              <AlertTriangle className="size-3.5" />
            )}
            {active.privacyStatus === 'redacted' ? 'Redacted' : 'Unredacted'}
          </span>
          <span
            className={cn(
              'inline-flex items-center gap-1.5',
              !active.provenance.hashVerified && 'text-muted-foreground',
            )}
          >
            {active.provenance.hashVerified ? (
              <Check className="size-3.5" />
            ) : (
              <AlertTriangle className="size-3.5" />
            )}
            {active.provenance.hashVerified
              ? 'Manifest hashes verified'
              : 'Example data'}
          </span>
          {active.provenance.model && (
            <span className="text-muted-foreground">
              {active.provenance.model} · {active.provenance.reasoningEffort}
            </span>
          )}
          <span className="ml-auto text-muted-foreground">
            {unresolved
              ? `${unresolved} Insight${unresolved === 1 ? '' : 's'} unresolved`
              : 'All Insights resolved'}
          </span>
        </section>
      )}

      <div className="grid min-h-[calc(100vh-7rem)] grid-cols-1 xl:grid-cols-[minmax(0,1.15fr)_minmax(390px,.85fr)]">
        <section
          className="min-w-0 border-b xl:border-b-0 xl:border-r"
          aria-labelledby="summary-heading"
        >
          <div className="flex h-14 items-center justify-between border-b bg-muted/20 px-4 sm:px-6">
            <div className="flex items-center gap-2">
              <FileText className="size-4 text-muted-foreground" />
              <h1 id="summary-heading" className="font-semibold">
                Summary
              </h1>
              <Badge variant="secondary">{active.summaryLines.length}</Badge>
            </div>
            <Button
              size="sm"
              variant="outline"
              onClick={() => openCreate('summary')}
            >
              <Plus data-icon="inline-start" />
              Add line
            </Button>
          </div>
          <ScrollArea className="h-[560px] xl:h-[calc(100vh-10.5rem)]">
            {active.format === 'v5' ? (
              <div className="mx-auto max-w-4xl px-3 py-6 sm:px-7">
                {active.summaryLines.length ? (
                  <RichSummary
                    markdown={summaryMarkdown(active.summaryLines)}
                    lines={active.summaryLines}
                    evidence={evidence}
                    onEdit={(lineId) => openEditor('summary', lineId)}
                    onDelete={(lineId) =>
                      setDeleteTarget({ kind: 'summary', id: lineId })
                    }
                  />
                ) : (
                  <EmptyState
                    label="No Summary content retained"
                    onAdd={() => openCreate('summary')}
                  />
                )}
              </div>
            ) : (
              <LegacySummary
                review={active}
                evidence={evidence}
                onEdit={openEditor}
                onDelete={(id) => setDeleteTarget({ kind: 'summary', id })}
              />
            )}
          </ScrollArea>
        </section>

        <section className="min-w-0" aria-labelledby="insights-heading">
          <div className="flex h-14 items-center justify-between border-b bg-muted/20 px-4 sm:px-6">
            <div className="flex items-center gap-2">
              <Lightbulb className="size-4 text-muted-foreground" />
              <h2 id="insights-heading" className="font-semibold">
                Insight cards
              </h2>
              <Badge variant="secondary">{active.insights.length}</Badge>
            </div>
            <Button
              size="sm"
              variant="outline"
              onClick={() => openCreate('insight')}
            >
              <Plus data-icon="inline-start" />
              Add insight
            </Button>
          </div>
          <ScrollArea className="h-[620px] xl:h-[calc(100vh-10.5rem)]">
            {active.insights.length ? (
              <div className="space-y-3 p-4 sm:p-5">
                {active.insights.map((insight) => (
                  <InsightCard
                    key={insight.id}
                    insight={insight}
                    skillCandidate={skillCandidates}
                    structured={
                      active.format === 'v5' ||
                      insight.authorship === 'reviewer'
                    }
                    selected={insight.id === selected?.id}
                    onSelect={() => setSelectedInsight(insight.id)}
                    onEvidence={(lineId) => jumpToEvidence(insight.id, lineId)}
                    onEdit={() => openEditor('insight', insight.id)}
                    onDelete={() =>
                      setDeleteTarget({ kind: 'insight', id: insight.id })
                    }
                    onStatus={(status) => setInsightStatus(insight.id, status)}
                  />
                ))}
              </div>
            ) : (
              <EmptyState
                label="No supported Insights retained"
                onAdd={() => openCreate('insight')}
              />
            )}
          </ScrollArea>
        </section>
      </div>

      <Sheet
        open={Boolean(editorTarget)}
        onOpenChange={(open) => {
          if (!open) setEditorTarget(null);
        }}
      >
        <SheetContent className="h-dvh max-h-dvh gap-0 overflow-hidden sm:max-w-xl">
          <SheetHeader className="shrink-0 border-b px-6 py-5">
            <SheetTitle>
              {editorTarget?.mode === 'add' ? 'Add' : 'Edit'}{' '}
              {editorTarget?.kind === 'trajectory'
                ? 'Trajectory summary'
                : editorTarget?.kind === 'group'
                  ? `Summary group ${editorTarget.id}`
                  : editorTarget?.kind === 'summary'
                    ? `Summary line ${editorTarget.id}`
                    : `Insight ${editorTarget?.id ?? ''}`}
            </SheetTitle>
            <SheetDescription>
              Changes are stored as an append-only review revision.
            </SheetDescription>
          </SheetHeader>
          <ScrollArea className="min-h-0 flex-1 overscroll-contain">
            <div className="space-y-5 p-6">
              {markdownEditor && (
                <div className="space-y-4">
                  <p className="text-sm leading-6 text-muted-foreground">
                    Paste one{' '}
                    {skillCandidates
                      ? 'skill candidate using Title, Type, Description, Example'
                      : 'insight using Title, Type, Scope, Takeaway'}
                    , and optional Evidence. You can write it yourself or use
                    the chatbot prompt with summary excerpts and your thoughts.
                    No file upload is needed.
                  </p>
                  <div className="flex flex-wrap items-center gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={async () => {
                        try {
                          const response = await fetch(
                            reviewerInsightPromptPath(active.protocolVersion),
                          );
                          if (!response.ok)
                            throw new Error('Unable to load prompt.');
                          await navigator.clipboard.writeText(
                            await response.text(),
                          );
                          setPromptFeedback(
                            'Prompt copied. Paste it into your chatbot, then add your excerpts and thoughts.',
                          );
                        } catch {
                          setPromptFeedback(
                            'Could not copy automatically. Open the prompt link and copy its text.',
                          );
                        }
                      }}
                    >
                      Copy chatbot prompt
                    </Button>
                    <a
                      className="text-sm underline"
                      href={reviewerInsightPromptPath(active.protocolVersion)}
                      target="_blank"
                      rel="noreferrer"
                    >
                      Open prompt
                    </a>
                  </div>
                  {promptFeedback && (
                    <output className="block text-sm text-muted-foreground">
                      {promptFeedback}
                    </output>
                  )}
                  <Field label="Insight Markdown" htmlFor="insight-markdown">
                    <Textarea
                      id="insight-markdown"
                      className="min-h-72 resize-y font-mono text-sm leading-6"
                      value={draftText}
                      onChange={(event) => setDraftText(event.target.value)}
                      placeholder={reviewerInsightExample(
                        active.protocolVersion,
                      )}
                    />
                  </Field>
                  <p className="text-xs text-muted-foreground">
                    Evidence may be omitted or left blank for your own insight.
                    If you include line IDs, they must refer to this
                    review&apos;s Summary.
                  </p>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setShowPreview((value) => !value)}
                  >
                    {showPreview ? 'Hide preview' : 'Preview card'}
                  </Button>
                  {showPreview && previewError && (
                    <p role="alert" className="text-sm text-destructive">
                      {previewError}
                    </p>
                  )}
                  {showPreview && preview && (
                    <div className="space-y-3 rounded-md border bg-muted/20 p-4">
                      <h3 className="font-semibold">{preview.title}</h3>
                      <p className="text-xs text-muted-foreground">
                        {preview.type}
                      </p>
                      {skillCandidates ? (
                        <>
                          <strong>Description</strong>
                          <InsightProse markdown={preview.description ?? ''} />
                          {workflowField && (
                            <>
                              <strong>Workflow</strong>
                              <InsightProse markdown={preview.workflow ?? ''} />
                            </>
                          )}
                          <strong>Example</strong>
                          <InsightProse markdown={preview.example ?? ''} />
                        </>
                      ) : (
                        <>
                          <InsightTakeaway markdown={preview.takeaway ?? ''} />
                          <p className="text-sm text-muted-foreground">
                            <strong>Scope:</strong> {preview.scope}
                          </p>
                        </>
                      )}
                      <p className="text-xs text-muted-foreground">
                        Evidence:{' '}
                        {preview.evidence.join(', ') ||
                          'Not provided (optional)'}
                      </p>
                    </div>
                  )}
                </div>
              )}

              {editorTarget?.kind === 'insight' && !markdownEditor && (
                <>
                  <Field label="Title" htmlFor="insight-title">
                    <Input
                      id="insight-title"
                      value={draftTitle}
                      onChange={(event) => setDraftTitle(event.target.value)}
                    />
                  </Field>
                  {active.format === 'v5' ? (
                    <>
                      <Field label="Type" htmlFor="insight-type">
                        <select
                          id="insight-type"
                          value={draftType}
                          onChange={(event) => setDraftType(event.target.value)}
                          className="h-10 w-full rounded-md border bg-background px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        >
                          <option value="">Not specified</option>
                          {!insightTypes.includes(
                            draftType as (typeof insightTypes)[number],
                          ) &&
                            draftType && (
                              <option value={draftType}>{draftType}</option>
                            )}
                          {insightTypes.map((type) => (
                            <option key={type} value={type}>
                              {type}
                            </option>
                          ))}
                        </select>
                      </Field>
                      {skillCandidates ? (
                        <>
                          <Field
                            label="Description"
                            htmlFor="insight-description"
                          >
                            <Textarea
                              id="insight-description"
                              className="min-h-24 resize-y"
                              aria-describedby={
                                workflowField
                                  ? 'description-guidance'
                                  : undefined
                              }
                              value={draftDescription}
                              onChange={(event) =>
                                setDraftDescription(event.target.value)
                              }
                            />
                            {workflowField && (
                              <span
                                id="description-guidance"
                                className="block text-xs text-muted-foreground"
                              >
                                Briefly explain the capability and when to use
                                it.
                              </span>
                            )}
                          </Field>
                          {workflowField && (
                            <Field label="Workflow" htmlFor="insight-workflow">
                              <Textarea
                                id="insight-workflow"
                                className="min-h-32 resize-y"
                                aria-describedby="workflow-guidance"
                                value={draftWorkflow}
                                onChange={(event) =>
                                  setDraftWorkflow(event.target.value)
                                }
                              />
                              <span
                                id="workflow-guidance"
                                className="block text-xs text-muted-foreground"
                              >
                                Describe reusable actions, decisions, and
                                constraints beyond the original project.
                              </span>
                            </Field>
                          )}
                          <Field label="Example" htmlFor="insight-example">
                            <Textarea
                              id="insight-example"
                              className="min-h-32 resize-y"
                              aria-describedby={
                                workflowField ? 'example-guidance' : undefined
                              }
                              value={draftExample}
                              onChange={(event) =>
                                setDraftExample(event.target.value)
                              }
                            />
                            {workflowField && (
                              <span
                                id="example-guidance"
                                className="block text-xs text-muted-foreground"
                              >
                                Show a recorded application through
                                understandable tasks, choices, and results.
                                Preserve what was reported, observed, attempted,
                                or unresolved.
                              </span>
                            )}
                          </Field>
                        </>
                      ) : (
                        <>
                          <Field label="Applies when" htmlFor="applies-when">
                            <Textarea
                              id="applies-when"
                              className="min-h-20 resize-y"
                              value={draftAppliesWhen}
                              onChange={(event) =>
                                setDraftAppliesWhen(event.target.value)
                              }
                            />
                          </Field>
                          <Field label="Scope" htmlFor="insight-scope">
                            <Textarea
                              id="insight-scope"
                              className="min-h-20 resize-y"
                              value={draftScope}
                              onChange={(event) =>
                                setDraftScope(event.target.value)
                              }
                            />
                          </Field>
                          <Field label="Takeaway" htmlFor="insight-takeaway">
                            <Textarea
                              id="insight-takeaway"
                              className="min-h-24 resize-y"
                              value={draftTakeaway}
                              onChange={(event) =>
                                setDraftTakeaway(event.target.value)
                              }
                            />
                          </Field>
                          <Field label="Why" htmlFor="insight-why">
                            <Textarea
                              id="insight-why"
                              className="min-h-24 resize-y"
                              value={draftWhy}
                              onChange={(event) =>
                                setDraftWhy(event.target.value)
                              }
                            />
                          </Field>
                          <Field label="Additional text" htmlFor="insight-text">
                            <Textarea
                              id="insight-text"
                              className="min-h-24 resize-y"
                              value={draftText}
                              onChange={(event) =>
                                setDraftText(event.target.value)
                              }
                            />
                          </Field>
                        </>
                      )}
                    </>
                  ) : (
                    <Field label="Insight text" htmlFor="reviewed-text">
                      <Textarea
                        id="reviewed-text"
                        className="min-h-40 resize-y text-base leading-7"
                        value={draftText}
                        onChange={(event) => setDraftText(event.target.value)}
                      />
                    </Field>
                  )}
                  <Field label="Summary evidence" htmlFor="evidence-lines">
                    <Input
                      id="evidence-lines"
                      className="font-mono"
                      value={draftEvidence}
                      onChange={(event) => setDraftEvidence(event.target.value)}
                      placeholder="L009, L017"
                    />
                  </Field>
                </>
              )}

              {editorTarget && editorTarget.kind !== 'insight' && (
                <Field label="Summary text" htmlFor="reviewed-text">
                  <Input
                    id="reviewed-text"
                    value={draftText}
                    onChange={(event) => setDraftText(event.target.value)}
                  />
                </Field>
              )}

              {editorTarget?.mode === 'edit' && (
                <div className="space-y-2">
                  <p className="text-xs font-semibold uppercase text-muted-foreground">
                    Original generated text
                  </p>
                  <div className="max-h-40 overflow-auto rounded-md border bg-muted/40 p-4 text-sm leading-6 text-muted-foreground whitespace-pre-wrap">
                    {editorTarget.kind === 'trajectory'
                      ? active.trajectorySummary.originalText
                      : editorTarget.kind === 'group'
                        ? active.summaryGroups.find(
                            (group) => group.id === editorTarget.id,
                          )?.originalText || 'Added during review'
                        : editorTarget.kind === 'summary'
                          ? active.summaryLines.find(
                              (line) => line.id === editorTarget.id,
                            )?.originalText || 'Added during review'
                          : active.insights.find(
                              (insight) => insight.id === editorTarget.id,
                            )?.originalText || 'Added during review'}
                  </div>
                </div>
              )}

              <Field label="Revision note" htmlFor="change-note">
                <Textarea
                  id="change-note"
                  className="min-h-20 resize-y"
                  value={changeNote}
                  onChange={(event) => setChangeNote(event.target.value)}
                />
              </Field>
              {editorError && (
                <p role="alert" className="text-sm text-destructive">
                  {editorError}
                </p>
              )}
            </div>
          </ScrollArea>
          <SheetFooter className="mt-0 shrink-0 border-t bg-muted/30 px-6 py-4 pb-[max(1rem,env(safe-area-inset-bottom))] sm:flex-row sm:justify-end">
            <Button variant="outline" onClick={() => setEditorTarget(null)}>
              Cancel
            </Button>
            <Button onClick={applyEditor}>
              {editorTarget?.mode === 'add' ? 'Add item' : 'Apply edit'}
            </Button>
          </SheetFooter>
        </SheetContent>
      </Sheet>

      <AlertDialog
        open={Boolean(deleteTarget)}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {deleteTarget?.kind === 'insight' ? 'Delete' : 'Remove'}{' '}
              {deleteTarget?.id}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              {deleteTarget?.kind === 'insight'
                ? 'Delete this insight from the review. Use the cross to decline it and retain its record.'
                : referencesToDelete > 0
                  ? `This line is cited by ${referencesToDelete} Insight${referencesToDelete === 1 ? '' : 's'}. Those cards will require evidence review.`
                  : 'The generated original remains preserved in review history.'}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={confirmDelete}>
              {deleteTarget?.kind === 'insight' ? 'Delete' : 'Remove'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </main>
  );
}

function InsightKeyLabel({ children }: { children: ReactNode }) {
  return (
    <span className="inline-flex rounded-sm border border-[color:var(--insight-border)] bg-[color:var(--insight-bg)] px-1.5 py-0.5 text-[10px] font-bold uppercase text-[color:var(--insight-strong)]">
      {children}
    </span>
  );
}

function insightTypeClasses(type?: string) {
  switch (type) {
    case 'user-agent':
    case 'user explicit':
      return {
        badge:
          'border-[color:var(--type-explicit-border)] bg-[color:var(--type-explicit-bg)] text-[color:var(--type-explicit-strong)]',
        selected:
          'border-[color:var(--type-explicit-border)] bg-[color:var(--type-explicit-bg)] shadow-[inset_3px_0_0_var(--type-explicit-strong)] ring-1 ring-inset ring-[color:var(--type-explicit-border)]',
      };
    case 'user implicit':
      return {
        badge:
          'border-[color:var(--type-implicit-border)] bg-[color:var(--type-implicit-bg)] text-[color:var(--type-implicit-strong)]',
        selected:
          'border-[color:var(--type-implicit-border)] bg-[color:var(--type-implicit-bg)] shadow-[inset_3px_0_0_var(--type-implicit-strong)] ring-1 ring-inset ring-[color:var(--type-implicit-border)]',
      };
    case 'agent':
    case 'agent encountered':
      return {
        badge:
          'border-[color:var(--type-agent-border)] bg-[color:var(--type-agent-bg)] text-[color:var(--type-agent-strong)]',
        selected:
          'border-[color:var(--type-agent-border)] bg-[color:var(--type-agent-bg)] shadow-[inset_3px_0_0_var(--type-agent-strong)] ring-1 ring-inset ring-[color:var(--type-agent-border)]',
      };
    default:
      return {
        badge:
          'border-[color:var(--insight-border)] bg-[color:var(--insight-bg)] text-[color:var(--insight-strong)]',
        selected:
          'border-[color:var(--insight-border)] bg-[color:var(--insight-bg)] ring-1 ring-inset ring-[color:var(--insight-border)]',
      };
  }
}

function InsightCard({
  insight,
  structured,
  skillCandidate,
  selected,
  onSelect,
  onEvidence,
  onEdit,
  onDelete,
  onStatus,
}: {
  insight: Insight;
  structured: boolean;
  skillCandidate: boolean;
  selected: boolean;
  onSelect: () => void;
  onEvidence: (lineId: string) => void;
  onEdit: () => void;
  onDelete: () => void;
  onStatus: (status: InsightStatus) => void;
}) {
  const keys = new Set<InsightKey>(detectedInsightKeys(insight));
  const typeClasses = insightTypeClasses(insight.type);

  return (
    <article
      className={cn(
        'rounded-lg border bg-card transition-[background-color,border-color,box-shadow]',
        selected && typeClasses.selected,
        insight.status === 'rejected' && 'opacity-60',
      )}
    >
      <div className="min-w-0 p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-mono text-xs font-bold text-muted-foreground">
                {insight.id}
              </span>
              {insight.authorship === 'reviewer' && (
                <Badge variant="secondary">Added by reviewer</Badge>
              )}
              {structured && keys.has('type') && insight.type && (
                <Badge variant="outline" className={typeClasses.badge}>
                  {insight.type}
                </Badge>
              )}
            </div>
            <div className="mt-3 flex min-w-0 items-baseline gap-2">
              {structured && keys.has('title') && (
                <InsightKeyLabel>Title</InsightKeyLabel>
              )}
              <h3 className="min-w-0 font-semibold leading-6">
                <button
                  type="button"
                  aria-pressed={selected}
                  className="rounded-sm text-left hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                  onClick={onSelect}
                >
                  {insight.title}
                </button>
              </h3>
            </div>
          </div>
          <span
            className={cn(
              'shrink-0 text-[10px] font-semibold uppercase text-muted-foreground',
              insight.status === 'needs_review' && 'text-destructive',
              insight.status === 'accepted' &&
                'text-[color:var(--evidence-strong)]',
            )}
          >
            {insightStatusLabel(insight.status)}
          </span>
        </div>
        {structured ? (
          <>
            {skillCandidate ? (
              <>
                <div className="mt-4 rounded-sm border-l-2 border-[color:var(--insight-border)] bg-[color:var(--insight-bg)] px-3 py-2.5">
                  <InsightKeyLabel>Description</InsightKeyLabel>
                  <InsightProse markdown={insight.description ?? ''} />
                </div>
                {keys.has('workflow') && (
                  <div className="mt-4 text-sm leading-6 text-muted-foreground">
                    <InsightKeyLabel>Workflow</InsightKeyLabel>
                    <InsightProse markdown={insight.workflow ?? ''} />
                  </div>
                )}
                <div className="mt-4 text-sm leading-6 text-muted-foreground">
                  <InsightKeyLabel>Example</InsightKeyLabel>
                  <InsightProse markdown={insight.example ?? ''} />
                </div>
              </>
            ) : (
              <>
                {keys.has('takeaway') && insight.takeaway && (
                  <div className="mt-4 rounded-sm border-l-2 border-[color:var(--insight-border)] bg-[color:var(--insight-bg)] px-3 py-2.5">
                    <InsightKeyLabel>Takeaway</InsightKeyLabel>
                    <InsightTakeaway markdown={insight.takeaway} />
                  </div>
                )}
                <dl className="mt-4 space-y-3 text-sm leading-6 text-muted-foreground">
                  {insight.appliesWhen && (
                    <div>
                      <dt className="font-semibold text-foreground">
                        Applies when
                      </dt>
                      <dd>{insight.appliesWhen}</dd>
                    </div>
                  )}
                  {keys.has('scope') && insight.scope && (
                    <div className="rounded-sm bg-[color:var(--insight-bg)] px-3 py-2">
                      <dt>
                        <InsightKeyLabel>Scope</InsightKeyLabel>
                      </dt>
                      <dd className="mt-1">{insight.scope}</dd>
                    </div>
                  )}
                  {insight.why && (
                    <div>
                      <dt className="font-semibold text-foreground">Why</dt>
                      <dd>{insight.why}</dd>
                    </div>
                  )}
                </dl>
                {insight.text && (
                  <p className="mt-4 whitespace-pre-wrap text-sm leading-6 text-muted-foreground">
                    {insight.text}
                  </p>
                )}
              </>
            )}
          </>
        ) : (
          <p className="mt-3 text-[15px] leading-7 text-muted-foreground">
            {insight.text}
          </p>
        )}
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3 border-t px-4 py-3">
        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
          {structured && keys.has('evidence') && (
            <InsightKeyLabel>Evidence</InsightKeyLabel>
          )}
          {insight.evidence.map((line) => (
            <button
              key={line}
              type="button"
              className="rounded-md border border-[color:var(--evidence-border)] bg-[color:var(--evidence-bg)] px-2 py-1 font-mono text-xs font-semibold text-[color:var(--evidence-strong)]"
              onClick={() => onEvidence(line)}
            >
              {line}
            </button>
          ))}
          {!insight.evidence.length && (
            <span
              className={cn(
                'text-xs',
                insight.authorship === 'reviewer'
                  ? 'text-muted-foreground'
                  : 'text-destructive',
              )}
            >
              {insight.authorship === 'reviewer'
                ? 'Evidence not provided (optional)'
                : insight.status === 'rejected'
                  ? 'Declined'
                  : 'Evidence needs repair'}
            </span>
          )}
        </div>
        <div className="flex shrink-0 gap-1">
          <Button
            aria-label={`Accept ${insight.id}`}
            title={`Accept ${insight.id}`}
            variant={insight.status === 'accepted' ? 'default' : 'ghost'}
            size="icon-sm"
            onClick={() => onStatus('accepted')}
          >
            <Check />
          </Button>
          <Button
            aria-label={`Decline ${insight.id}`}
            title={`Decline ${insight.id}; keep in export`}
            variant={insight.status === 'rejected' ? 'destructive' : 'ghost'}
            size="icon-sm"
            onClick={() => onStatus('rejected')}
          >
            <X />
          </Button>
          <Button
            aria-label={`Edit ${insight.id}`}
            title={`Edit ${insight.id}`}
            variant="ghost"
            size="icon-sm"
            onClick={onEdit}
          >
            <PencilLine />
          </Button>
          <Button
            aria-label={`Delete ${insight.id}`}
            title={`Delete ${insight.id}`}
            variant="ghost"
            size="icon-sm"
            className="text-muted-foreground hover:text-destructive"
            onClick={onDelete}
          >
            <Trash2 />
          </Button>
        </div>
      </div>
    </article>
  );
}

function LegacySummary({
  review,
  evidence,
  onEdit,
  onDelete,
}: {
  review: Review;
  evidence: Set<string>;
  onEdit: (kind: ItemKind, id: string) => void;
  onDelete: (id: string) => void;
}) {
  const renderLine = (line: SummaryLine) => (
    <div
      id={line.id}
      key={line.id}
      className={cn(
        'grid grid-cols-[48px_minmax(0,1fr)_64px] gap-3 rounded-md px-3 py-3',
        evidence.has(line.id) && 'bg-[color:var(--evidence-bg)]',
      )}
    >
      <code className="pt-1 text-xs font-semibold text-muted-foreground">
        {line.id}
      </code>
      <p className="text-[15px] leading-7">{line.text}</p>
      <div className="flex gap-1">
        <Button
          aria-label={`Edit ${line.id}`}
          variant="ghost"
          size="icon-sm"
          onClick={() => onEdit('summary', line.id)}
        >
          <PencilLine />
        </Button>
        <Button
          aria-label={`Remove ${line.id}`}
          variant="ghost"
          size="icon-sm"
          onClick={() => onDelete(line.id)}
        >
          <Trash2 />
        </Button>
      </div>
    </div>
  );

  return (
    <div className="space-y-5 p-4 sm:p-6">
      {review.trajectorySummary.text && (
        <section className="border-b pb-5">
          <div className="flex items-center justify-between">
            <h2 className="font-semibold">Trajectory summary</h2>
            <Button
              aria-label="Edit trajectory summary"
              variant="ghost"
              size="icon-sm"
              onClick={() => onEdit('trajectory', 'trajectory')}
            >
              <PencilLine />
            </Button>
          </div>
          <p className="mt-2 text-lg leading-8">
            {review.trajectorySummary.text}
          </p>
        </section>
      )}
      {review.summaryGroups.length
        ? review.summaryGroups.map((group) => (
            <section key={group.id} className="rounded-lg border bg-card">
              <div className="flex items-start gap-3 border-b p-4">
                <code className="pt-1 text-xs font-bold text-muted-foreground">
                  {group.id}
                </code>
                <p className="min-w-0 flex-1 leading-7">{group.text}</p>
                <Button
                  aria-label={`Edit ${group.id}`}
                  variant="ghost"
                  size="icon-sm"
                  onClick={() => onEdit('group', group.id)}
                >
                  <PencilLine />
                </Button>
              </div>
              <div className="p-2">
                {group.lineIds
                  .map((id) =>
                    review.summaryLines.find((line) => line.id === id),
                  )
                  .filter((line): line is SummaryLine => Boolean(line))
                  .map(renderLine)}
              </div>
            </section>
          ))
        : review.summaryLines.map(renderLine)}
    </div>
  );
}

function Field({
  label,
  htmlFor,
  children,
}: {
  label: string;
  htmlFor: string;
  children: React.ReactNode;
}) {
  return (
    <label htmlFor={htmlFor} className="block space-y-2">
      <span className="text-xs font-semibold uppercase text-muted-foreground">
        {label}
      </span>
      {children}
    </label>
  );
}

function EmptyState({ label, onAdd }: { label: string; onAdd: () => void }) {
  return (
    <div className="grid min-h-72 place-items-center p-8 text-center">
      <div>
        <FilePlus2 className="mx-auto mb-3 size-7 text-muted-foreground" />
        <p className="mb-4 text-sm text-muted-foreground">{label}</p>
        <Button variant="outline" onClick={onAdd}>
          <Plus data-icon="inline-start" />
          Add one
        </Button>
      </div>
    </div>
  );
}

function CenteredMessage({ label }: { label: string }) {
  return (
    <main className="grid min-h-screen place-items-center bg-background px-6 text-foreground">
      <div className="text-center">
        <span className="mx-auto grid size-11 place-items-center rounded-lg bg-primary text-primary-foreground">
          <Sparkles className="size-5" />
        </span>
        <p className="mt-4 text-sm text-muted-foreground">{label}</p>
      </div>
    </main>
  );
}
