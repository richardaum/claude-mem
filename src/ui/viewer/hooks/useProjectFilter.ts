import { useCallback, useEffect, useState } from 'react';

export const PROJECT_QUERY_PARAM = 'project';

export function readProjectFilter(search: string): string {
  return new URLSearchParams(search).get(PROJECT_QUERY_PARAM) ?? '';
}

export function buildProjectFilterUrl(href: string, project: string): string {
  const url = new URL(href);

  if (project) {
    url.searchParams.set(PROJECT_QUERY_PARAM, project);
  } else {
    url.searchParams.delete(PROJECT_QUERY_PARAM);
  }

  return `${url.pathname}${url.search}${url.hash}`;
}

function readCurrentProjectFilter(): string {
  return typeof window === 'undefined' ? '' : readProjectFilter(window.location.search);
}

export function useProjectFilter() {
  const [currentFilter, setCurrentFilterState] = useState(readCurrentProjectFilter);

  useEffect(() => {
    const handlePopState = () => {
      setCurrentFilterState(readCurrentProjectFilter());
    };

    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, []);

  const updateProjectFilter = useCallback((project: string, replace: boolean) => {
    setCurrentFilterState(project);

    const nextUrl = buildProjectFilterUrl(window.location.href, project);
    const currentUrl = `${window.location.pathname}${window.location.search}${window.location.hash}`;
    if (nextUrl === currentUrl) return;

    const method = replace ? 'replaceState' : 'pushState';
    window.history[method](window.history.state, '', nextUrl);
  }, []);

  const setCurrentFilter = useCallback((project: string) => {
    updateProjectFilter(project, false);
  }, [updateProjectFilter]);

  const replaceCurrentFilter = useCallback((project: string) => {
    updateProjectFilter(project, true);
  }, [updateProjectFilter]);

  return {
    currentFilter,
    setCurrentFilter,
    replaceCurrentFilter
  };
}
