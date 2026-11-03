import { useEffect, useState } from 'react';
import type { WorkspaceClient, WorkspaceListType } from './client';

export function useWorkspaceListRevision(client: WorkspaceClient, type: WorkspaceListType): number {
  const [revision, setRevision] = useState(0);
  useEffect(() => client.subscribe?.(types => {
    if (types.includes(type)) setRevision(value => value + 1);
  }), [client, type]);
  return revision;
}
