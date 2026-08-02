import { Routes } from '@angular/router';
import { HomeComponent }    from './pages/home/home.component';
import { ProfileComponent } from './pages/profile/profile.component';
import { BlocksComponent } from './pages/catalogue/blocks/blocks.component';
import { WeaponsComponent } from './pages/catalogue/weapons/weapons.component';
import { ProjectilesComponent } from './pages/catalogue/projectiles/projectiles.component';
import { ArtifactsComponent } from './pages/catalogue/artifacts/artifacts.component';
import { ToolsComponent } from './pages/catalogue/tools/tools.component';
import { StatusEffectsComponent } from './pages/catalogue/status-effects/status-effects.component';
import { MonstersComponent } from './pages/catalogue/monsters/monsters.component';
import { MapsComponent } from './pages/catalogue/maps/maps.component';
import { PortalsComponent } from './pages/catalogue/portals/portals.component';
import { ParametrageComponent } from './pages/parametrage/parametrage.component';

export const routes: Routes = [
  { path: '',        component: HomeComponent },
  { path: 'profile', component: ProfileComponent },
  { path: 'catalogue/blocks',        component: BlocksComponent },
  { path: 'catalogue/armes',         component: WeaponsComponent },
  { path: 'catalogue/projectiles',   component: ProjectilesComponent },
  { path: 'catalogue/artefacts',     component: ArtifactsComponent },
  { path: 'catalogue/outils',        component: ToolsComponent },
  { path: 'catalogue/effets-statut', component: StatusEffectsComponent },
  { path: 'catalogue/monstres',      component: MonstersComponent },
  { path: 'catalogue/cartes',        component: MapsComponent },
  { path: 'catalogue/portails',      component: PortalsComponent },
  {
    path: 'jouer',
    loadComponent: () => import('./pages/play/play.component').then(m => m.PlayComponent),
  },
  { path: 'parametrage', component: ParametrageComponent },
  { path: '**',      redirectTo: '' },
];
