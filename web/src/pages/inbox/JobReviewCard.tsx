// Carte de décision d'une offre dans le centre de validation (complétée avec le pipeline d'analyse).
import { Link } from 'wouter';
import { Button, Card } from '../../components/ui';
import type { ActionItem } from '../Inbox';

export function JobReviewCard({ item }: { item: ActionItem; onDone: () => void }) {
  return (
    <Card className="p-4">
      <p className="text-sm font-semibold text-slate-900">{item.title}</p>
      {item.jobId && (
        <Link href={`/offres/${item.jobId}`}>
          <Button size="sm" variant="primary" className="mt-3">
            Ouvrir
          </Button>
        </Link>
      )}
    </Card>
  );
}
