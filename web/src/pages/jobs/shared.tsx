// Éléments communs aux écrans d'offres : types, pastilles de statut et de note, rendu du rapport.
import { type ReactNode } from 'react';
import { ATS_DECISION_LABELS, STAGE_LABELS, type AtsDecision, type Stage } from '../../../../src/shared/stages';
import { CONTRACT_LABELS } from '../../../../src/shared/search';
import { Badge, type Tone } from '../../components/ui';
import { countryName, cx } from '../../lib/format';

export interface JobListItem {
  id: string;
  companyName: string;
  title: string;
  locationRaw: string;
  city: string;
  country: string;
  remote: string;
  contractType: string;
  seniority: string;
  stage: Stage;
  stageChangedAt: string;
  relevanceScore: number | null;
  fitScore: number | null;
  priorityScore: number | null;
  strategic: boolean;
  atsScore: number | null;
  atsDecision: string;
  starred: boolean;
  userDecision: string;
  sourcesCount: number;
  postedAt: string | null;
  deadlineAt: string | null;
  firstSeenAt: string;
  lastSeenAt: string;
  expiredAt: string | null;
  canonicalUrl: string;
  applyUrl: string;
  flags: Record<string, any>;
  qualification: { summary?: string; strengths?: string[]; gaps?: string[]; blockers?: string[]; rules?: { profile: string | null; warnings: string[]; reasons: string[] } } | null;
}

export interface Job extends JobListItem {
  descriptionText: string;
  notes: string;
  language: string;
  yearsMin: number | null;
  yearsMax: number | null;
  qualificationMethod: string;
  latestAnalysisId: string | null;
}

const STAGE_TONES: Partial<Record<Stage, Tone>> = {
  new: 'neutral',
  to_analyze: 'info',
  analyzed: 'neutral',
  awaiting_feedback: 'brand',
  cv_in_progress: 'info',
  letter_in_progress: 'info',
  ready_to_apply: 'success',
  applying: 'info',
  sent: 'success',
  confirmed: 'success',
  interview_hr: 'brand',
  interview_tech: 'brand',
  offer: 'success',
  rejected: 'danger',
  no_response: 'neutral',
  follow_up_needed: 'warning',
  abandoned: 'neutral',
  filtered: 'neutral',
  expired: 'neutral',
};

export function StageBadge({ stage }: { stage: Stage }) {
  return <Badge tone={STAGE_TONES[stage] ?? 'neutral'}>{STAGE_LABELS[stage] ?? stage}</Badge>;
}

const DECISION_TONES: Record<string, string> = {
  excellent: 'bg-emerald-600 text-white',
  interesting: 'bg-indigo-600 text-white',
  limited: 'bg-amber-500 text-white',
  weak: 'bg-slate-400 text-white',
};

/** Note ATS sur 20, colorée selon les seuils de décision. */
export function AtsPill({ score, decision, size = 'md' }: { score: number | null; decision: string; size?: 'md' | 'lg' }) {
  if (score == null) return <span className={cx('inline-flex items-center justify-center rounded-lg bg-slate-100 font-semibold text-slate-400', size === 'lg' ? 'h-12 w-16 text-base' : 'h-8 w-12 text-xs')}>—</span>;
  return (
    <span
      title={ATS_DECISION_LABELS[decision as AtsDecision] ?? 'Note ATS'}
      className={cx('inline-flex flex-col items-center justify-center rounded-lg font-semibold tabular-nums', DECISION_TONES[decision] ?? 'bg-slate-200 text-slate-700', size === 'lg' ? 'h-12 w-16 text-lg leading-none' : 'h-8 w-12 text-[13px] leading-none')}
    >
      {score.toLocaleString('fr-FR', { maximumFractionDigits: 1 })}
      <span className={cx('font-medium opacity-80', size === 'lg' ? 'mt-0.5 text-[10px]' : 'text-[9px]')}>/20</span>
    </span>
  );
}

/** Jauge horizontale 0-100 (pertinence, adéquation, priorité). */
export function ScoreBar({ label, value, hint }: { label: string; value: number | null; hint?: string }) {
  return (
    <div title={hint}>
      <div className="flex items-baseline justify-between text-[12px]">
        <span className="text-slate-500">{label}</span>
        <span className="font-semibold text-slate-800 tabular-nums">{value == null ? '—' : Math.round(value)}</span>
      </div>
      <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-slate-100">
        <div className={cx('h-full rounded-full', value == null ? '' : value >= 75 ? 'bg-emerald-500' : value >= 55 ? 'bg-indigo-500' : value >= 35 ? 'bg-amber-400' : 'bg-slate-300')} style={{ width: `${Math.max(0, Math.min(100, value ?? 0))}%` }} />
      </div>
    </div>
  );
}

export function jobPlace(j: Pick<JobListItem, 'city' | 'country' | 'locationRaw' | 'remote'>): string {
  const place = j.city ? `${j.city}${j.country ? `, ${countryName(j.country)}` : ''}` : j.locationRaw || (j.country ? countryName(j.country) : '');
  const mode = j.remote === 'remote' ? 'Télétravail' : j.remote === 'hybrid' ? 'Hybride' : '';
  return [place, mode].filter(Boolean).join(' · ');
}

export function contractLabel(c: string): string {
  return CONTRACT_LABELS[c as keyof typeof CONTRACT_LABELS] ?? '';
}

export const fileUrl = (id: string | null | undefined, download = false) => (id ? `/api/files/${id}${download ? '?download=1' : ''}` : '');

// ── Rendu d'un rapport en texte balisé (titres, tableaux, listes, gras), sans HTML injecté ──

function inline(text: string, key: number): ReactNode {
  const parts = text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g).filter(Boolean);
  return (
    <span key={key}>
      {parts.map((p, i) => (p.startsWith('**') && p.endsWith('**') ? <strong key={i} className="font-semibold text-slate-900">{p.slice(2, -2)}</strong> : p.startsWith('`') && p.endsWith('`') ? <code key={i} className="rounded bg-slate-100 px-1 text-[12px]">{p.slice(1, -1)}</code> : p))}
    </span>
  );
}

const cells = (line: string) => {
  const c = line.split('|').map((x) => x.trim());
  if (c[0] === '') c.shift();
  if (c[c.length - 1] === '') c.pop();
  return c;
};

export function Report({ text }: { text: string }) {
  const lines = text.replace(/\r/g, '').split('\n');
  const out: ReactNode[] = [];
  let i = 0;
  let k = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (!line.trim()) {
      i++;
      continue;
    }
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) {
      out.push(
        <p key={k++} className={cx('font-semibold text-slate-900', h[1]!.length <= 2 ? 'mt-5 text-[15px]' : 'mt-4 text-sm')}>
          {inline(h[2]!.replace(/\*\*/g, ''), 0)}
        </p>,
      );
      i++;
      continue;
    }
    if (line.includes('|') && lines[i + 1] && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1]!)) {
      const head = cells(line);
      const rows: string[][] = [];
      i += 2;
      while (i < lines.length && lines[i]!.includes('|')) rows.push(cells(lines[i++]!));
      out.push(
        <div key={k++} className="scroll-thin mt-2 overflow-x-auto rounded-lg ring-1 ring-slate-200">
          <table className="w-full text-left text-[13px]">
            <thead className="bg-slate-50 text-[12px] text-slate-500">
              <tr>{head.map((c, j) => <th key={j} className="px-3 py-2 font-medium">{inline(c, j)}</th>)}</tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {rows.map((r, ri) => (
                <tr key={ri} className="align-top">{r.map((c, j) => <td key={j} className={cx('px-3 py-2 text-slate-700', j === 0 && 'font-medium text-slate-900')}>{inline(c, j)}</td>)}</tr>
              ))}
            </tbody>
          </table>
        </div>,
      );
      continue;
    }
    if (/^\s*([-*•]|\d+[.)])\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*([-*•]|\d+[.)])\s+/.test(lines[i]!)) items.push(lines[i++]!.replace(/^\s*([-*•]|\d+[.)])\s+/, ''));
      out.push(
        <ul key={k++} className="mt-1.5 list-disc space-y-0.5 pl-5 text-[13px] leading-relaxed text-slate-700">
          {items.map((it, j) => <li key={j}>{inline(it, j)}</li>)}
        </ul>,
      );
      continue;
    }
    const para: string[] = [];
    while (i < lines.length && lines[i]!.trim() && !/^(#{1,6})\s/.test(lines[i]!) && !/^\s*([-*•]|\d+[.)])\s+/.test(lines[i]!) && !(lines[i]!.includes('|') && lines[i + 1] && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1]!))) para.push(lines[i++]!);
    out.push(
      <p key={k++} className="mt-2 text-[13px] leading-relaxed text-slate-700">
        {inline(para.join(' '), 0)}
      </p>,
    );
  }
  return <div>{out}</div>;
}
