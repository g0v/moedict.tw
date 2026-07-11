import { DictionaryPage } from './DictionaryPage';

interface DictionaryProps {
  word?: string;
  idx?: number;
}

export function DictionaryH({ word, idx }: DictionaryProps) {
  return <DictionaryPage word={word} lang="h" idx={idx} />;
}
