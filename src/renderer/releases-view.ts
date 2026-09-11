/**
 * Release Notes (Sürüm Notları) view module.
 *
 * Renders an aesthetic, searchable, categorized timeline of all versions
 * and detailed changes in Chat On Steroids.
 */

import { el, icon, toast } from './dom.js';
import { RELEASES_DATA } from './releases-data.js';
import type { ReleaseCategory, ReleaseChangeItem, ReleaseEntry } from './releases-data.js';

function btn(className = '', text = ''): HTMLButtonElement {
  const b = el('button', className, text) as HTMLButtonElement;
  b.type = 'button';
  return b;
}

let activeCategory: string = 'all';
let searchQuery: string = '';

const CATEGORY_LABELS: Record<string, { label: string; icon: string }> = {
  all: { label: 'All Changes', icon: 'i-steps' },
  feat: { label: 'Features & Capabilities', icon: 'i-bolt' },
  core: { label: 'Core & Architecture', icon: 'i-terminal' },
  fix: { label: 'Reliability & Fixes', icon: 'i-pulse' },
  sec: { label: 'Security & Sandbox', icon: 'i-lock' },
  ui: { label: 'UI & Polish', icon: 'i-pencil' }
};

export function initReleasesView(containerId = 'releasesMount'): void {
  activeCategory = 'all';
  searchQuery = '';
  const mount = document.getElementById(containerId);
  if (!mount) return;

  mount.replaceChildren();

  // ------------------------------------------------------------- 1. Hero Deck
  const hero = el('header', 'releases-hero');
  const heroTop = el('div', 'releases-hero-top');
  const eyebrow = el('span', 'overview-eyebrow', 'Version History · Sürüm Notları');
  const title = el('h1', 'releases-title', 'Release Notes & Changelog');
  const lead = el(
    'p',
    'releases-lead',
    'Complete documented history of architectural leaps, multi-agent orchestration, security models, and visual refinements in Chat On Steroids.'
  );

  heroTop.append(eyebrow, title, lead);

  const stats = el('div', 'releases-stats');
  const statReleases = createStatBox(String(RELEASES_DATA.length), 'Total Versions', 'From v1.9.2 to v2.2.0');
  const statActive = createStatBox('v2.1.2 / v2.2.0', 'Active Stream', 'Core supervisor & LAN agent');
  const totalChanges = RELEASES_DATA.reduce(
    (acc, r) => acc + r.categories.reduce((cAcc, c) => cAcc + c.items.length, 0),
    0
  );
  const statChanges = createStatBox(`${totalChanges}+`, 'Documented Changes', 'Every commit classified');

  stats.append(statReleases, statActive, statChanges);
  hero.append(heroTop, stats);

  // ----------------------------------------------------------- 2. Control Bar
  const controls = el('div', 'releases-controls card');

  // Search row
  const searchRow = el('div', 'releases-search-row');
  const searchIcon = icon('i-search', 'ico releases-search-ico');
  const searchInput = el('input', 'releases-search-input') as HTMLInputElement;
  searchInput.type = 'text';
  searchInput.id = 'releasesSearchInput';
  searchInput.placeholder = 'Search changes, tools, capabilities, bug fixes…';
  searchInput.setAttribute('aria-label', 'Search release notes');

  searchInput.addEventListener('input', () => {
    searchQuery = searchInput.value.trim().toLowerCase();
    renderTimeline();
  });

  const clearBtn = btn('btn btn-icon releases-clear-btn');
  clearBtn.title = 'Clear search';
  clearBtn.append(icon('i-x'));
  clearBtn.addEventListener('click', () => {
    if (searchInput.value) {
      searchInput.value = '';
      searchQuery = '';
      renderTimeline();
    }
  });

  searchRow.append(searchIcon, searchInput, clearBtn);

  // Category filter chips
  const filterRow = el('div', 'releases-filter-row');
  const filterLabel = el('span', 'releases-filter-label', 'Filter:');
  const filterGroup = el('div', 'releases-filter-group');

  for (const [catId, meta] of Object.entries(CATEGORY_LABELS)) {
    const filterBtn = btn('releases-filter-btn', meta.label);
    filterBtn.dataset.category = catId;
    if (catId === activeCategory) filterBtn.classList.add('is-active');

    filterBtn.addEventListener('click', () => {
      activeCategory = catId;
      for (const sibling of filterGroup.querySelectorAll('.releases-filter-btn')) {
        sibling.classList.toggle('is-active', (sibling as HTMLElement).dataset.category === catId);
      }
      renderTimeline();
    });

    filterGroup.append(filterBtn);
  }

  filterRow.append(filterLabel, filterGroup);

  // Version Quick-Jump Bar
  const jumpRow = el('div', 'releases-jump-row');
  const jumpLabel = el('span', 'releases-jump-label', 'Quick Jump:');
  const jumpScroll = el('div', 'releases-jump-scroll');

  for (const release of RELEASES_DATA) {
    const pill = btn('releases-jump-pill');
    pill.append(el('strong', '', `v${release.version}`));
    if (release.channel === 'dev') {
      pill.classList.add('is-dev');
    } else if (release.channel === 'stable' && release.version === '2.1.2') {
      pill.classList.add('is-latest');
    }

    pill.addEventListener('click', () => {
      const card = document.getElementById(`release-card-${release.version.replace(/\./g, '-')}`);
      if (card) {
        card.scrollIntoView({ behavior: 'smooth', block: 'start' });
        card.classList.add('is-focused');
        window.setTimeout(() => card.classList.remove('is-focused'), 1800);
      }
    });

    jumpScroll.append(pill);
  }

  jumpRow.append(jumpLabel, jumpScroll);

  controls.append(searchRow, filterRow, jumpRow);

  // ------------------------------------------------------------- 3. Timeline
  const timelineContainer = el('div', 'releases-timeline');
  timelineContainer.id = 'releasesTimelineContainer';

  mount.append(hero, controls, timelineContainer);

  renderTimeline();
}

function createStatBox(primary: string, label: string, detail: string): HTMLElement {
  const box = el('div', 'releases-stat-box');
  const val = el('strong', 'releases-stat-val', primary);
  const lbl = el('span', 'releases-stat-lbl', label);
  const det = el('small', 'releases-stat-det', detail);
  box.append(val, lbl, det);
  return box;
}

function renderTimeline(): void {
  const container = document.getElementById('releasesTimelineContainer');
  if (!container) return;

  container.replaceChildren();

  let visibleCount = 0;

  for (const release of RELEASES_DATA) {
    const renderedCard = buildReleaseCard(release, searchQuery, activeCategory);
    if (renderedCard) {
      container.append(renderedCard);
      visibleCount++;
    }
  }

  if (visibleCount === 0) {
    const empty = el('div', 'releases-empty card');
    const emptyIcon = icon('i-search', 'ico releases-empty-ico');
    const emptyTitle = el('h3', '', 'No matching releases found');
    const emptyDesc = el(
      'p',
      '',
      `No changes found matching filter "${activeCategory}" with query "${searchQuery}". Try clearing filters.`
    );
    empty.append(emptyIcon, emptyTitle, emptyDesc);
    container.append(empty);
  }
}

function buildReleaseCard(release: ReleaseEntry, query: string, categoryFilter: string): HTMLElement | null {
  // Check if this release matches query and category
  const matchesCategory = (cat: ReleaseCategory): boolean => {
    return categoryFilter === 'all' || cat.id === categoryFilter;
  };

  const filteredCategories: ReleaseCategory[] = [];

  for (const cat of release.categories) {
    if (!matchesCategory(cat)) continue;

    if (!query) {
      filteredCategories.push(cat);
      continue;
    }

    const matchingItems: ReleaseChangeItem[] = [];
    for (const item of cat.items) {
      const matchText = item.text.toLowerCase().includes(query);
      const matchBadge = item.badge?.toLowerCase().includes(query);
      if (matchText || matchBadge) {
        matchingItems.push(item);
      }
    }

    if (matchingItems.length > 0) {
      filteredCategories.push({ ...cat, items: matchingItems });
    }
  }

  // Also check if query matches version, title, summary, or highlights
  const releaseMatchesHeader =
    query &&
    (release.version.toLowerCase().includes(query) ||
      release.title.toLowerCase().includes(query) ||
      release.summary.toLowerCase().includes(query) ||
      (release.highlights && release.highlights.some((h) => h.toLowerCase().includes(query))));

  // If header matches and category filter matches, retain categories even if individual items didn't match
  let effectiveCategories = filteredCategories;
  if (releaseMatchesHeader && effectiveCategories.length === 0) {
    effectiveCategories = release.categories.filter((c) => matchesCategory(c));
  }

  if (effectiveCategories.length === 0 && !releaseMatchesHeader) {
    return null;
  }

  // Build card
  const cardId = `release-card-${release.version.replace(/\./g, '-')}`;
  const card = el('article', 'release-card card');
  card.id = cardId;
  card.dataset.version = release.version;
  card.dataset.channel = release.channel;

  // Header
  const header = el('header', 'release-card-header');
  const titleRow = el('div', 'release-title-row');

  const versionBadge = el('span', `release-version-pill is-${release.channel}`, `v${release.version}`);
  const tagBadge = el('span', 'release-tag-pill', release.tag);
  const dateBadge = el('span', 'release-date-pill', release.date);

  titleRow.append(versionBadge, tagBadge, dateBadge);

  const heading = el('h2', 'release-title-text', release.title);

  const actions = el('div', 'release-card-actions');
  const copyBtn = btn('btn btn-quiet releases-copy-btn');
  copyBtn.title = `Copy v${release.version} release notes`;
  copyBtn.append(icon('i-copy'), el('span', '', 'Copy notes'));

  copyBtn.addEventListener('click', () => {
    copyReleaseMarkdown(release);
  });

  actions.append(copyBtn);

  header.append(titleRow, heading, actions);

  // Summary callout
  const summaryBox = el('div', 'release-summary-box');
  const summaryText = el('p', 'release-summary-text', release.summary);
  summaryBox.append(summaryText);

  // Highlights list
  let highlightsBox: HTMLElement | null = null;
  if (release.highlights && release.highlights.length > 0) {
    highlightsBox = el('div', 'release-highlights-box');
    const highlightsTitle = el('h4', 'release-section-subhead', 'Key Highlights');
    const highlightsList = el('ul', 'release-highlights-list');
    for (const h of release.highlights) {
      const li = el('li', '', h);
      highlightsList.append(li);
    }
    highlightsBox.append(highlightsTitle, highlightsList);
  }

  // Categories & items
  const categoriesContainer = el('div', 'release-categories-container');

  for (const cat of effectiveCategories) {
    const catSection = el('section', `release-category-section is-${cat.id}`);
    const catHeader = el('h3', 'release-category-title');
    const meta = CATEGORY_LABELS[cat.id] ?? { label: cat.title, icon: 'i-steps' };
    catHeader.append(icon(meta.icon, 'ico release-category-ico'), el('span', '', cat.title));

    const itemList = el('ul', 'release-items-list');
    for (const item of cat.items) {
      const li = el('li', 'release-item');
      if (item.badge) {
        const badge = el('span', 'release-item-badge', item.badge);
        li.append(badge);
      }
      const textSpan = el('span', 'release-item-text', item.text);
      li.append(textSpan);
      itemList.append(li);
    }

    catSection.append(catHeader, itemList);
    categoriesContainer.append(catSection);
  }

  // Artifacts & downloads (if provided)
  let artifactsSection: HTMLElement | null = null;
  if (release.artifacts && release.artifacts.length > 0) {
    artifactsSection = el('div', 'release-artifacts-box');
    const artTitle = el('h4', 'release-section-subhead', 'Shipped Artifacts');
    const artChips = el('div', 'release-artifacts-chips');
    for (const art of release.artifacts) {
      const chip = el('span', 'release-artifact-chip');
      chip.append(icon('i-out', 'ico release-artifact-ico'), el('code', '', art));
      artChips.append(chip);
    }
    artifactsSection.append(artTitle, artChips);
  }

  card.append(header, summaryBox);
  if (highlightsBox) card.append(highlightsBox);
  card.append(categoriesContainer);
  if (artifactsSection) card.append(artifactsSection);

  return card;
}

function copyReleaseMarkdown(release: ReleaseEntry): void {
  const lines: string[] = [];
  lines.push(`## Chat On Steroids v${release.version} — ${release.title}`);
  lines.push(`**Date**: ${release.date} | **Channel**: ${release.tag}`);
  lines.push('');
  lines.push(release.summary);
  lines.push('');

  if (release.highlights && release.highlights.length > 0) {
    lines.push('### Highlights');
    for (const h of release.highlights) {
      lines.push(`- ${h}`);
    }
    lines.push('');
  }

  for (const cat of release.categories) {
    lines.push(`### ${cat.title}`);
    for (const item of cat.items) {
      const badgePrefix = item.badge ? `**[${item.badge}]** ` : '';
      lines.push(`- ${badgePrefix}${item.text}`);
    }
    lines.push('');
  }

  if (release.artifacts && release.artifacts.length > 0) {
    lines.push('### Artifacts');
    for (const art of release.artifacts) {
      lines.push(`- \`${art}\``);
    }
    lines.push('');
  }

  const text = lines.join('\n');
  navigator.clipboard
    .writeText(text)
    .then(() => {
      toast(`Copied v${release.version} release notes to clipboard`);
    })
    .catch(() => {
      toast('Failed to copy to clipboard');
    });
}
