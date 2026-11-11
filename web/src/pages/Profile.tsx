import { useLocation, useParams } from 'wouter';
import { PageHeader, Tabs } from '../components/ui';
import { AnswersTab } from './profile/AnswersTab';
import { AtsPromptTab } from './profile/AtsPromptTab';
import { CvTab } from './profile/CvTab';
import { FactsTab } from './profile/FactsTab';
import { LinkedinTab } from './profile/LinkedinTab';

const TABS = [
  { id: 'cv', label: 'Mes documents' },
  { id: 'informations', label: 'Mes informations' },
  { id: 'reponses', label: 'Réponses standards' },
  { id: 'prompt-ats', label: 'Prompt ATS' },
  { id: 'linkedin', label: 'LinkedIn' },
] as const;
type TabId = (typeof TABS)[number]['id'];

export function ProfilePage() {
  const params = useParams<{ tab?: string }>();
  const [, navigate] = useLocation();
  const tab = (TABS.some((t) => t.id === params.tab) ? params.tab : 'cv') as TabId;
  return (
    <>
      <PageHeader title="Profil" description="Votre référentiel : tout ce que l'agent sait de vous. Il ne s'appuie que sur ce que vous avez validé ici." />
      <Tabs tabs={[...TABS]} value={tab} onChange={(id) => navigate(`/profil/${id}`)} className="mb-5" />
      {tab === 'cv' && <CvTab />}
      {tab === 'informations' && <FactsTab />}
      {tab === 'reponses' && <AnswersTab />}
      {tab === 'prompt-ats' && <AtsPromptTab />}
      {tab === 'linkedin' && <LinkedinTab />}
    </>
  );
}
