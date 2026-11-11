// Point d'enregistrement des modules métier (routes, tâches, initialisations).
// Importé une seule fois au démarrage ; chaque module s'enregistre par effet de bord.
import { registerRoutes } from './api/app.js';
import { overviewRoutes } from './api/routes/overview.js';

registerRoutes('private', (app, deps) => app.route('/overview', overviewRoutes(deps)));
