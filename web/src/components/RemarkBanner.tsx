import type { NextRoundRequest } from '../api';
import { formatDate } from './ui';

/** The hiring manager's remark when a candidate was sent to this round. Shown to recruiters and interviewers alike. */
export function RemarkBanner({ request }: { request: NextRoundRequest | null }) {
  if (!request?.remark) return null;
  return (
    <aside className="remark" aria-label="Remark from the hiring manager">
      <span className="remark-label">Sent to this round{request.by ? ` by ${request.by}` : ''} · {formatDate(request.at)}</span>
      <p>“{request.remark}”</p>
    </aside>
  );
}
