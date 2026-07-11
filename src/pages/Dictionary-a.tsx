import { DictionaryPage } from './DictionaryPage';

interface DictionaryProps {
  word?: string;
  idx?: number;
}

export function DictionaryA({ word, idx }: DictionaryProps) {
  return <DictionaryPage word={word} lang="a" idx={idx} />;
}
