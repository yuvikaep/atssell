import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { useState } from 'react';
import { api, type NotificationItem, type TaskItem } from '../api';
import { Badge, EmptyState, ErrorState, formatDate, Loading } from '../components/ui';
import { notificationsQuery, tasksQuery } from '../queries';

const GROUP_OF = (type: string) =>
  type.startsWith('interview.') || type.startsWith('feedback.') ? 'Interviews and feedback'
  : type.startsWith('requisition.') || type.startsWith('approval.') || type.startsWith('offer.') ? 'Approvals'
  : type.startsWith('submission.') || type.startsWith('agency.') ? 'New submissions'
  : type.startsWith('joining.') ? 'Joining follow-ups' : 'Other';
const GROUP_ORDER = ['Interviews and feedback', 'Approvals', 'New submissions', 'Joining follow-ups', 'Other'];

const taskPath = (t: TaskItem) =>
  !t.entity_id ? null
  : t.entity_type === 'interview' ? `/interviews/${t.entity_id}`
  : t.entity_type === 'offer' ? `/offers/${t.entity_id}`
  : t.entity_type === 'requisition' ? `/requisitions/${t.entity_id}`
  : null;

/** The task centre: what needs attention, grouped, with a way to open it and clear it. */
export function NotificationsPage() {
  const [unreadOnly, setUnreadOnly] = useState(false);
  const notices = useQuery(notificationsQuery(unreadOnly));
  const tasks = useQuery(tasksQuery('open'));
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const refresh = () => Promise.all(['notifications', 'unread-count', 'tasks'].map((k) => queryClient.invalidateQueries({ queryKey: [k] })));
  const read = useMutation({ mutationFn: (id: string) => api('POST', `/notifications/${id}/read`), onSuccess: refresh });
  const readAll = useMutation({ mutationFn: () => api('POST', '/notifications/read-all'), onSuccess: refresh });
  const complete = useMutation({ mutationFn: (id: string) => api('POST', `/tasks/${id}/complete`), onSuccess: refresh });

  const open = async (n: NotificationItem) => {
    if (!n.read) await read.mutateAsync(n.id);
    if (n.link) await navigate({ to: n.link as '/' });
  };

  const groups = new Map<string, NotificationItem[]>();
  for (const n of notices.data?.data ?? []) groups.set(GROUP_OF(n.type), [...(groups.get(GROUP_OF(n.type)) ?? []), n]);

  return (
    <>
      <div className="page-header">
        <div>
          <h1>Tasks and notifications</h1>
          <p>What needs your attention. Email is a copy: nothing here depends on it arriving.</p>
        </div>
        <button className="btn" onClick={() => readAll.mutate()} disabled={readAll.isPending || !notices.data?.data.some((n) => !n.read)}>Mark all as read</button>
      </div>

      <div className="card" style={{ marginBottom: 16 }}>
        <div className="toolbar"><h2>To do</h2><span className="muted">{tasks.data?.length ?? 0}</span></div>
        {tasks.isPending ? <Loading /> : tasks.isError ? <ErrorState error={tasks.error} onRetry={() => tasks.refetch()} /> : tasks.data.length === 0 ? (
          <p className="empty-inline" style={{ padding: '4px 16px 16px' }}>Nothing to do right now.</p>
        ) : (
          <div className="table-wrap">
            <table>
              <tbody>
                {tasks.data.map((t) => (
                  <tr key={t.id}>
                    <td><strong>{t.title}</strong>{t.due_at && <div className="cell-sub">{t.overdue ? 'Overdue since ' : 'Due '}{formatDate(t.due_at)}</div>}</td>
                    <td>{t.overdue && <Badge tone="danger">Overdue</Badge>}</td>
                    <td className="actions">
                      {taskPath(t) && <button className="btn btn-sm" onClick={() => navigate({ to: taskPath(t) as '/' })}>Open</button>}
                      <button className="btn btn-sm" disabled={complete.isPending} onClick={() => complete.mutate(t.id)}>Done</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="card">
        <div className="toolbar">
          <h2>Notifications</h2><span style={{ flex: 1 }} />
          <label className="check"><input type="checkbox" checked={unreadOnly} onChange={(e) => setUnreadOnly(e.target.checked)} /> Unread only</label>
        </div>
        {notices.isPending ? <Loading /> : notices.isError ? <ErrorState error={notices.error} onRetry={() => notices.refetch()} /> : notices.data.data.length === 0 ? (
          <EmptyState title={unreadOnly ? 'No unread notifications' : 'No notifications yet'}>You will see interview, feedback and approval updates here.</EmptyState>
        ) : (
          GROUP_ORDER.filter((g) => groups.has(g)).map((g) => (
            <div key={g}>
              <div className="nav-section" style={{ padding: '12px 16px 4px' }}>{g}</div>
              {groups.get(g)!.map((n) => (
                <button key={n.id} className="notice" data-unread={!n.read} onClick={() => open(n)}>
                  <span className="notice-title">{n.title}</span>
                  <span className="notice-body">{n.body}</span>
                  <span className="cell-sub">{formatDate(n.created_at)}</span>
                </button>
              ))}
            </div>
          ))
        )}
      </div>
    </>
  );
}
