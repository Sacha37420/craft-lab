import { Component, ElementRef, HostListener, inject, signal, ViewChild } from '@angular/core';
import { NgTemplateOutlet } from '@angular/common';
import { RouterOutlet, RouterLink, RouterLinkActive } from '@angular/router';
import { KeycloakService } from './core/keycloak.service';
import { ThemeService } from './core/theme.service';

type NavEntry =
  | { kind: 'section'; label: string }
  | { kind: 'link'; label: string; abbr: string; path: string; exact?: boolean };

const MOBILE_CLOSE_ANIM_MS = 220;

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [RouterOutlet, RouterLink, RouterLinkActive, NgTemplateOutlet],
  templateUrl: './app.html',
  styleUrl: './app.scss',
})
export class AppComponent {
  protected kc = inject(KeycloakService);
  protected theme = inject(ThemeService);

  collapsed = signal(false);
  mobileOpen = signal(false);
  mobileClosing = signal(false);

  protected noop = (): void => {};
  protected closeMobileFn = (): void => this.closeMobile();

  readonly navEntries: NavEntry[] = [
    { kind: 'link', path: '/',        label: 'Accueil', abbr: 'Ac', exact: true },
    { kind: 'section', label: 'Catalogue' },
    { kind: 'link', path: '/catalogue/blocks',       label: 'Blocks',              abbr: 'Bl' },
    { kind: 'link', path: '/catalogue/armes',        label: 'Armes',               abbr: 'Ar' },
    { kind: 'link', path: '/catalogue/projectiles',  label: 'Projectiles',         abbr: 'Pj' },
    { kind: 'link', path: '/catalogue/artefacts',    label: 'Artefacts',           abbr: 'At' },
    { kind: 'link', path: '/catalogue/outils',       label: 'Outils',              abbr: 'Ou' },
    { kind: 'link', path: '/catalogue/effets-statut', label: 'Effets de statut',   abbr: 'Es' },
    { kind: 'section', label: 'Compte' },
    { kind: 'link', path: '/profile', label: 'Profil',  abbr: 'Pr' },
    { kind: 'link', path: '/parametrage', label: 'Paramétrage', abbr: 'Pa' },
  ];

  @ViewChild('closeBtn') private closeBtnRef?: ElementRef<HTMLButtonElement>;
  @ViewChild('burgerBtn') private burgerBtnRef?: ElementRef<HTMLButtonElement>;

  toggleCollapsed(): void {
    this.collapsed.update(v => !v);
  }

  openMobile(): void {
    this.mobileOpen.set(true);
    this.mobileClosing.set(false);
    document.body.style.overflow = 'hidden';
    setTimeout(() => this.closeBtnRef?.nativeElement.focus());
  }

  closeMobile(): void {
    if (!this.mobileOpen() || this.mobileClosing()) return;
    this.mobileClosing.set(true);
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    setTimeout(() => {
      this.mobileOpen.set(false);
      this.mobileClosing.set(false);
      document.body.style.overflow = '';
      this.burgerBtnRef?.nativeElement.focus();
    }, reduced ? 0 : MOBILE_CLOSE_ANIM_MS);
  }

  @HostListener('document:keydown.escape')
  onEscape(): void {
    if (this.mobileOpen()) this.closeMobile();
  }

  get username(): string {
    return this.kc.username || this.kc.email;
  }

  logout(): void {
    this.kc.logout();
  }
}

// Export pour Angular standalone
export { AppComponent as App };
