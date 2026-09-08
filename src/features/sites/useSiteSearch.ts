import type { Dispatch, RefObject, SetStateAction } from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ManagedSite } from '../../shared/types.ts';
import { createSiteSearchIndex, searchSites } from './siteSearchModel.ts';

interface UseSiteSearchOptions {
  entries: readonly ManagedSite[];
  entriesById: ReadonlyMap<string, ManagedSite>;
}

export interface SiteSearchModel {
  closeSearch: () => void;
  filteredSites: ManagedSite[];
  isSearching: boolean;
  searchInputRef: RefObject<HTMLInputElement>;
  searchOpen: boolean;
  searchQuery: string;
  setSearchOpen: Dispatch<SetStateAction<boolean>>;
  setSearchQuery: Dispatch<SetStateAction<string>>;
}

export function useSiteSearch({ entries, entriesById }: UseSiteSearchOptions): SiteSearchModel {
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const searchInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (searchOpen) searchInputRef.current?.focus();
  }, [searchOpen]);

  const closeSearch = useCallback(() => {
    setSearchOpen(false);
    searchInputRef.current?.blur();
  }, []);

  const trimmedQuery = searchQuery.trim().toLowerCase();
  const isSearching = trimmedQuery.length > 0;
  const searchIndex = useMemo(
    () => createSiteSearchIndex(entries, entriesById),
    [entries, entriesById],
  );
  const filteredSites = useMemo(
    () => searchSites(searchIndex, trimmedQuery),
    [searchIndex, trimmedQuery],
  );

  return {
    closeSearch,
    filteredSites,
    isSearching,
    searchInputRef,
    searchOpen,
    searchQuery,
    setSearchOpen,
    setSearchQuery,
  };
}
