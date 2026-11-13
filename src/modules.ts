// Point d'enregistrement des modules métier (routes, tâches, initialisations).
// Importé une seule fois au démarrage ; chaque module s'enregistre par effet de bord.
import { registerRoutes } from './api/app.js';
import { overviewRoutes } from './api/routes/overview.js';
import { filesRoutes, profileRoutes } from './api/routes/profile.js';
import { inboxRoutes } from './api/routes/inbox.js';
import { adminRoutes } from './api/routes/admin.js';
import { linkedinRoutes } from './api/routes/linkedin.js';
import { documentsRoutes } from './api/routes/documents.js';
import { jobsRoutes } from './api/routes/jobs.js';
import { applicationsRoutes } from './api/routes/applications.js';
import { applyRoutes } from './api/routes/apply.js';
import { searchRoutes } from './api/routes/search.js';
import { mailRoutes } from './api/routes/mail.js';
import { cronRoutes } from './api/routes/cron.js';
import './docs/index.js';
import './profile/index.js';
import './pipeline/index.js';
import './search/index.js';
import './tracker/index.js';
import './notify/index.js';
import './apply/index.js';

registerRoutes('public', (app, deps) => app.route('/cron', cronRoutes(deps)));
registerRoutes('private', (app, deps) => app.route('/overview', overviewRoutes(deps)));
registerRoutes('private', (app, deps) => app.route('/profile', profileRoutes(deps)));
registerRoutes('private', (app, deps) => app.route('/files', filesRoutes(deps)));
registerRoutes('private', (app, deps) => app.route('/inbox', inboxRoutes(deps)));
registerRoutes('private', (app, deps) => app.route('/admin', adminRoutes(deps)));
registerRoutes('private', (app, deps) => app.route('/profile/linkedin', linkedinRoutes(deps)));
registerRoutes('private', (app, deps) => app.route('/documents', documentsRoutes(deps)));
registerRoutes('private', (app, deps) => app.route('/jobs', jobsRoutes(deps)));
registerRoutes('private', (app, deps) => app.route('/applications', applicationsRoutes(deps)));
registerRoutes('private', (app, deps) => app.route('/apply', applyRoutes(deps)));
registerRoutes('private', (app, deps) => app.route('/search', searchRoutes(deps)));
registerRoutes('private', (app, deps) => app.route('/mail', mailRoutes(deps)));
