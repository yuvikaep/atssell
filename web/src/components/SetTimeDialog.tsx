import { useQuery } from '@tanstack/react-query';
import { interviewQuery } from '../queries';
import { ScheduleDialog } from './ScheduleDialog';
import { Dialog, ErrorState, Loading } from './ui';

/** Loads a draft round (for example one a hiring manager requested) and opens it to set the time. */
export function SetTimeDialog({ interviewId, onClose }: { interviewId: string; onClose: () => void }) {
  const q = useQuery(interviewQuery(interviewId));
  if (q.isPending || q.isError) {
    return (
      <Dialog open title="Set interview time" onClose={onClose} footer={<button className="btn" onClick={onClose}>Close</button>}>
        {q.isPending ? <Loading /> : <ErrorState error={q.error} onRetry={() => q.refetch()} />}
      </Dialog>
    );
  }
  return <ScheduleDialog interview={q.data} onClose={onClose} />;
}
