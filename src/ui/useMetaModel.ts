import { useEffect, useState } from 'react';
import { loadMetaModel, type MetaModel } from '../meta/infer';

// one fetch per page load: tab switches remount the views but reuse the
// same in-flight/resolved promise instead of refetching the artifact
let promise: Promise<MetaModel | null> | null = null;
const loadOnce = (): Promise<MetaModel | null> => {
  promise ??= loadMetaModel();
  return promise;
};

/** the trained meta-model artifact, or null when unavailable (shared fetch) */
export function useMetaModel(): MetaModel | null {
  const [model, setModel] = useState<MetaModel | null>(null);
  useEffect(() => {
    let alive = true;
    loadOnce().then((m) => {
      if (alive) setModel(m);
    });
    return () => {
      alive = false;
    };
  }, []);
  return model;
}
