/**
 * The assistant's retrieval corpus, emitted as a static asset at build time.
 *
 * ============================ CORPUS BOUNDARY ==============================
 * This file is the ONLY place approved sources are declared. Everything the
 * assistant can ever say is derived from what is read here:
 *
 *   1. published project pages      src/content/projects/**
 *   2. published articles           src/content/writing/**   (drafts excluded)
 *   3. about + experience           src/content/about.md, experience.md
 *   4. the curated knowledge file   src/knowledge/curated-profile.md
 *   5. the site's own public links  src/lib/site-links.ts
 *
 * All five are public content that already ships in this repository. There is
 * no crawler, no filesystem walk outside `src/`, and no network call at build
 * or at runtime. Do not widen this list without deliberately deciding that the
 * new source is public.
 * ===========================================================================
 */

import type { APIRoute } from 'astro';
import { getCollection, getEntry } from 'astro:content';
import { buildCorpus, experienceMarkdown, parseCuratedProfile } from '../../lib/assistant/corpus.ts';
import type { SourceDoc } from '../../lib/assistant/corpus.ts';
import { SITE_LINKS } from '../../lib/site-links.ts';

export const prerender = true;

const base = import.meta.env.BASE_URL;
const path = (segment: string) => `${base}${segment}`.replace(/\/{2,}/g, '/');

export const GET: APIRoute = async () => {
  const sources: SourceDoc[] = [];

  // 1. Projects
  for (const project of await getCollection('projects')) {
    const links = [{ label: 'View project', href: path(`projects/${project.id}`) }];
    if (project.data.github) links.push({ label: 'View GitHub repository', href: project.data.github });
    if (project.data.demo) links.push({ label: 'View live demo', href: project.data.demo });

    sources.push({
      id: `project:${project.id}`,
      title: project.data.title,
      description: project.data.description,
      type: 'project',
      url: links[0].href,
      tags: project.data.tags,
      date: project.data.date.toISOString().slice(0, 10),
      links,
      markdown: project.body ?? '',
    });
  }

  // 2. Articles — drafts stay out of the corpus, exactly as they stay off the site.
  for (const post of await getCollection('writing', ({ data }) => !data.draft)) {
    sources.push({
      id: `article:${post.id}`,
      title: post.data.title,
      description: post.data.description,
      type: 'article',
      url: path(`writing/${post.id}`),
      tags: post.data.tags,
      date: post.data.date.toISOString().slice(0, 10),
      links: [{ label: 'Read article', href: path(`writing/${post.id}`) }],
      markdown: post.body ?? '',
    });
  }

  // 3a. About
  const about = await getEntry('about', 'about');
  if (about) {
    sources.push({
      id: 'about',
      title: 'About Carl Broker',
      description: about.data.description,
      type: 'about',
      url: path('about'),
      tags: [],
      links: [{ label: 'Read about Carl', href: path('about') }],
      markdown: about.body ?? '',
    });
  }

  // 3b. Experience
  const experience = await getEntry('experience', 'experience');
  if (experience) {
    sources.push({
      id: 'experience',
      title: 'Career Experience',
      description: experience.data.description,
      type: 'experience',
      url: path('experience'),
      tags: [],
      links: [{ label: 'View experience', href: path('experience') }],
      markdown: experienceMarkdown(experience.data.entries),
    });
  }

  // 4. Curated knowledge — one source document per filled-in `##` section.
  const curated = await getEntry('knowledge', 'curated-profile');
  if (curated) sources.push(...parseCuratedProfile(curated.body ?? ''));

  // 5. Public contact points, as published on /contact.
  sources.push({
    id: 'links',
    title: 'Where To Find Carl Online',
    type: 'links',
    url: path('contact'),
    tags: ['github', 'linkedin', 'resume', 'contact'],
    links: [
      { label: 'View GitHub profile', href: SITE_LINKS[0].href },
      { label: 'View LinkedIn profile', href: SITE_LINKS[1].href },
    ],
    markdown: [
      '## Public profiles and code',
      '',
      `Carl's public code and repositories are on GitHub at ${SITE_LINKS[0].value}.`,
      `His professional profile is on LinkedIn at ${SITE_LINKS[1].value}.`,
      `He can be reached by email at ${SITE_LINKS[2].value}, and his resume is available`,
      'as a PDF from the contact page of this site.',
    ].join('\n'),
  });

  const corpus = buildCorpus(sources);

  return new Response(JSON.stringify(corpus), {
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
};
