/**
 * Carl's public contact points, as already published on `/contact`.
 * Kept here so the assistant corpus and any future component share one list.
 */
export const SITE_LINKS = [
  { label: 'GitHub', href: 'https://github.com/cbroker1', value: 'github.com/cbroker1' },
  {
    label: 'LinkedIn',
    href: 'https://www.linkedin.com/in/carl-broker-70211646/',
    value: 'linkedin.com/in/carl-broker',
  },
  { label: 'Email', href: 'mailto:carlbroker@gmail.com', value: 'carlbroker@gmail.com' },
  { label: 'Resume', href: '/resume/carl-broker-resume.pdf', value: 'Download PDF' },
] as const;
