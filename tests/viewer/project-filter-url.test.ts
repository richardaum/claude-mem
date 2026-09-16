import { describe, expect, it } from 'bun:test';
import {
  buildProjectFilterUrl,
  readProjectFilter,
} from '../../src/ui/viewer/hooks/useProjectFilter';

describe('project filter URL helpers', () => {
  it('reads a decoded project from the query string', () => {
    expect(readProjectFilter('?project=my%20project&view=compact')).toBe('my project');
  });

  it('returns the all-projects filter when the parameter is absent', () => {
    expect(readProjectFilter('?view=compact')).toBe('');
  });

  it('sets the project while preserving other parameters and the hash', () => {
    expect(buildProjectFilterUrl(
      'http://localhost:37701/?view=compact#recent',
      'my project',
    )).toBe('/?view=compact&project=my+project#recent');
  });

  it('removes only the project parameter for the all-projects filter', () => {
    expect(buildProjectFilterUrl(
      'http://localhost:37701/?project=my-project&view=compact#recent',
      '',
    )).toBe('/?view=compact#recent');
  });
});
