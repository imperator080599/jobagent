// Point d'enregistrement des modules métier (routes, tâches, initialisations).
// Importé une seule fois au démarrage ; chaque module s'enregistre par effet de bord.
import { registerRoutes } from './api/app.js';
import { overviewRoutes } from './api/routes/overview.js';
import { filesRoutes, profileRoutes } from './api/routes/profile.js';
import { inboxRoutes } from './api/routes/inbox.js';
import { adminRoutes } from './api/routes/admin.js';
import './profile/index.js';

registerRoutes('private', (app, deps) => app.route('/overview', overviewRoutes(deps)));
registerRoutes('private', (app, deps) => app.route('/profile', profileRoutes(deps)));
registerRoutes('private', (app, deps) => app.route('/files', filesRoutes(deps)));
registerRoutes('private', (app, deps) => app.route('/inbox', inboxRoutes(deps)));
registerRoutes('private', (app, deps) => app.route('/admin', adminRoutes(deps)));
