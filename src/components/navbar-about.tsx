/**
 * 關於頁面的導航列組件
 * 從 About.tsx 抽出
 */

import { Link } from 'react-router-dom';
import { M3eAppBar } from '@m3e/react/app-bar';
import { M3eIcon } from '@m3e/react/icon';
import { SvgIcon } from './SvgIcon';

interface NavbarAboutProps {
	r2Endpoint?: string;
}

/**
 * 關於頁面的導航列
 */
export function NavbarAbout({ r2Endpoint }: NavbarAboutProps) {
	return (
		<M3eAppBar className="navbar navbar-inverse navbar-fixed-top" size="small">
			<div slot="leading" style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
				<Link to="/" className="navbar-brand brand ebas home">
					萌典
				</Link>
				<a
					href="https://racklin.github.io/moedict-desktop/download.html"
					target="_blank"
					rel="noopener noreferrer"
					title="桌面版下載（可離線使用）"
					aria-label="桌面版下載（可離線使用）"
				>
					<M3eIcon name="download" aria-hidden="true" />
				</a>
			</div>
			<div slot="trailing" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
				<a href="http://g0v.tw/" target="_blank" rel="noopener noreferrer" title="g0v.tw 零時政府">
					{r2Endpoint && (
						<img
							src="/assets/images/g0v-icon-invert.png"
							height="32"
							width="96"
							alt="g0v.tw"
						/>
					)}
				</a>
				<Link to="/" title="回到萌典" aria-label="回到萌典" className="home">
					<SvgIcon name="removeCircle" size={18} aria-hidden="true" />
				</Link>
			</div>
		</M3eAppBar>
	);
}
