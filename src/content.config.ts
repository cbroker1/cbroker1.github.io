import { defineCollection } from 'astro:content';
import { z } from 'astro/zod';
import { glob } from 'astro/loaders';

const projects = defineCollection({
  loader: glob({ pattern: '**/*.{md,mdx}', base: './src/content/projects' }),
  schema: z.object({
    title: z.string(),
    description: z.string(),
    date: z.coerce.date(),
    tags: z.array(z.string()),
    image: z.string().optional(),
    github: z.string().url().optional(),
    demo: z.string().url().optional(),
    featured: z.boolean().default(false),
    status: z.enum(['complete', 'in-progress', 'archived']).default('complete'),
  }),
});

const writing = defineCollection({
  loader: glob({ pattern: '**/*.{md,mdx}', base: './src/content/writing' }),
  schema: z.object({
    title: z.string(),
    description: z.string(),
    date: z.coerce.date(),
    tags: z.array(z.string()).default([]),
    featured: z.boolean().default(false),
    draft: z.boolean().default(false),
  }),
});

const about = defineCollection({
  loader: glob({ pattern: 'about.md', base: './src/content' }),
  schema: z.object({
    title: z.string(),
    description: z.string(),
  }),
});

const experience = defineCollection({
  loader: glob({ pattern: 'experience.md', base: './src/content' }),
  schema: z.object({
    title: z.string(),
    description: z.string(),
    entries: z.array(z.object({
      years: z.string(),
      role: z.string(),
      company: z.string().optional(),
      description: z.string(),
      highlights: z.array(z.string()),
      technologies: z.array(z.string()),
    })),
  }),
});

export const collections = { projects, writing, about, experience };
