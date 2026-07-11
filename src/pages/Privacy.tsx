import { useEffect } from 'react';

/**
 * Standalone privacy page (no navbar). Token-driven so it tracks the
 * ambient <m3e-theme> light/dark scheme.
 */
export function Privacy() {
	useEffect(() => {
		document.title = '隱私權政策 - 萌典';
	}, []);

	return (
		<div className="privacy-page">
			<div className="privacy-card">
				<h1 className="privacy-heading">Privacy Policy</h1>
				<p className="privacy-body">
					<strong>萌典—教育部華語、台語、客語辭典民間版</strong> (MoeDict) by Audrey Tang collects no private data. Your data will not be used in any way, because we do not collect any.
				</p>

				<hr className="privacy-divider" />

				<h1 className="privacy-heading">隱私權政策</h1>
				<p className="privacy-body">
					由唐鳳開發的<strong>萌典—教育部華語、台語、客語辭典民間版</strong>不會蒐集個人資料。您的資料不會以任何方式被使用，因為我們根本不會蒐集任何資料。
				</p>
			</div>
		</div>
	);
}
