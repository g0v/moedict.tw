import { DictionaryPage } from "./DictionaryPage";

interface DictionaryProps {
  word?: string;
  idx?: number;
}

export function DictionaryT({ word, idx }: DictionaryProps) {
  return <DictionaryPage word={word} lang="t" idx={idx} />;
}
