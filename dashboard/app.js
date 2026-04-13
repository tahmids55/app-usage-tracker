const DAILY_URL = '/daily';
const DAILY_DATES_URL = '/daily-dates';
const REFRESH_MS = 5000;
const TREND_DAYS_LIMIT = 14;
const DUMMY_DAYS_BEFORE_TODAY = 7;
const TREND_SCALE_MAX_HOURS = 10;
const TREND_SCALE_MAX_SECONDS = TREND_SCALE_MAX_HOURS * 3600;

const state = {
	selectedDate: '',
	todayDate: '',
	dates: [],
	trendRows: [],
	expandedLegendKeys: new Set(),
};

const palette = ['#0b7285', '#2f855a', '#c05621', '#2b6cb0', '#d97706', '#0f766e', '#9f1239'];

function q(id) {
	return document.getElementById(id);
}

function formatDuration(totalSeconds) {
	const seconds = Math.max(0, Math.floor(Number(totalSeconds) || 0));
	const h = Math.floor(seconds / 3600);
	const m = Math.floor((seconds % 3600) / 60);
	if (h > 0)
		return `${h}h ${m}m`;
	return `${m}m`;
}

function shortLabel(name, max = 22) {
	const value = String(name || 'Unknown');
	if (value.length <= max)
		return value;
	return `${value.slice(0, max - 3)}...`;
}

function safeNumber(value) {
	const num = Number(value);
	if (!Number.isFinite(num) || num < 0)
		return 0;
	return num;
}

function localDateIso() {
	const now = new Date();
	const y = now.getFullYear();
	const m = String(now.getMonth() + 1).padStart(2, '0');
	const d = String(now.getDate()).padStart(2, '0');
	return `${y}-${m}-${d}`;
}

function dateFromIso(value) {
	if (!/^\d{4}-\d{2}-\d{2}$/.test(value))
		return null;

	const [y, m, d] = value.split('-').map(Number);
	return new Date(y, m - 1, d);
}

function isoFromDate(date) {
	const y = date.getFullYear();
	const m = String(date.getMonth() + 1).padStart(2, '0');
	const d = String(date.getDate()).padStart(2, '0');
	return `${y}-${m}-${d}`;
}

function buildRecentDateWindow(todayIso, daysBefore) {
	const end = dateFromIso(todayIso) || new Date();
	const rows = [];

	for (let i = daysBefore; i >= 0; i -= 1) {
		const dt = new Date(end.getFullYear(), end.getMonth(), end.getDate() - i);
		rows.push(isoFromDate(dt));
	}

	return rows;
}

function aggregateDomains(apps) {
	const totals = new Map();
	for (const app of apps) {
		for (const child of app.children) {
			const current = totals.get(child.name) || 0;
			totals.set(child.name, current + child.seconds);
		}
	}
	return Array.from(totals.entries())
		.map(([name, seconds]) => ({ name, seconds }))
		.sort((a, b) => b.seconds - a.seconds);
}

function normalizeStats(statsData) {
	const appsObj = statsData && typeof statsData === 'object' ? statsData.apps : null;
	const rows = [];

	if (appsObj && typeof appsObj === 'object') {
		for (const [name, entryRaw] of Object.entries(appsObj)) {
			const entry = entryRaw && typeof entryRaw === 'object' ? entryRaw : {};
			const childrenObj = entry.children && typeof entry.children === 'object' ? entry.children : {};
			const children = Object.entries(childrenObj)
				.map(([childName, seconds]) => ({ name: childName, seconds: safeNumber(seconds) }))
				.filter(child => child.name && child.seconds > 0)
				.sort((a, b) => b.seconds - a.seconds);

			const childTotal = children.reduce((sum, child) => sum + child.seconds, 0);
			const total = Math.max(safeNumber(entry.total), childTotal);
			if (!name || total <= 0)
				continue;

			rows.push({ name, total, children });
		}
	}

	rows.sort((a, b) => b.total - a.total);

	const totalSeconds = rows.reduce((sum, row) => sum + row.total, 0);
	const domains = aggregateDomains(rows);
	return { apps: rows, totalSeconds, domains };
}

function normalizeDateList(data) {
	if (!data || typeof data !== 'object' || !Array.isArray(data.dates))
		return [];

	const dates = data.dates
		.filter(v => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v));

	return Array.from(new Set(dates)).sort((a, b) => (a < b ? -1 : 1));
}

function makeDonutMarkup(items, label, totalSeconds) {
	const safeTotal = Math.max(0, Math.floor(totalSeconds));
	if (!items.length || safeTotal <= 0) {
		return `
			<div class="donut" style="background: conic-gradient(#dbe3e8 0 360deg)">
				<div class="donut-center">
					<div class="donut-value">0m</div>
					<div class="donut-label">${label}</div>
				</div>
			</div>
		`;
	}

	let degree = 0;
	const segments = [];
	items.forEach((item, index) => {
		const color = palette[index % palette.length];
		const slice = Math.max(1, Math.round((item.seconds / safeTotal) * 360));
		const next = Math.min(360, degree + slice);
		segments.push(`${color} ${degree}deg ${next}deg`);
		degree = next;
	});
	if (degree < 360)
		segments.push(`#dbe3e8 ${degree}deg 360deg`);

	return `
		<div class="donut" style="background: conic-gradient(${segments.join(', ')})">
			<div class="donut-center">
				<div class="donut-value">${formatDuration(safeTotal)}</div>
				<div class="donut-label">${label}</div>
			</div>
		</div>
	`;
}

function renderLegend(targetEl, items, baseTotal) {
	if (!targetEl)
		return;

	targetEl.innerHTML = '';
	const total = Math.max(1, Math.floor(baseTotal));

	items.forEach((item, index) => {
		const percent = Math.max(0, Math.round((item.seconds / total) * 100));
		const color = palette[index % palette.length];
		const row = document.createElement('div');
		row.className = 'legend-item';

		const left = document.createElement('div');
		left.className = 'legend-left';

		const swatch = document.createElement('span');
		swatch.className = 'swatch';
		swatch.style.background = color;

		const name = document.createElement('span');
		name.className = 'legend-name';
		name.title = item.name;
		name.textContent = shortLabel(item.name);

		const value = document.createElement('span');
		value.className = 'legend-val';
		value.textContent = `${formatDuration(item.seconds)} • ${percent}%`;

		left.appendChild(swatch);
		left.appendChild(name);
		row.appendChild(left);
		row.appendChild(value);
		targetEl.appendChild(row);
	});
}

function renderSelectedLegend(targetEl, apps, baseTotal) {
	if (!targetEl)
		return;

	targetEl.innerHTML = '';
	const total = Math.max(1, Math.floor(baseTotal));

	apps.forEach((app, index) => {
		const appPercent = Math.max(0, Math.round((app.total / total) * 100));
		const color = palette[index % palette.length];
		const hasChildren = Array.isArray(app.children) && app.children.length > 0;
		const legendKey = `${state.selectedDate}::${app.name}`;
		const isExpanded = hasChildren && state.expandedLegendKeys.has(legendKey);

		const item = document.createElement('div');
		item.className = 'legend-item legend-item-app';

		const head = document.createElement('div');
		head.className = 'legend-head';
		if (hasChildren)
			head.classList.add('legend-head-clickable');

		const left = document.createElement('div');
		left.className = 'legend-left';

		const swatch = document.createElement('span');
		swatch.className = 'swatch';
		swatch.style.background = color;

		const name = document.createElement('span');
		name.className = 'legend-name';
		name.title = app.name;
		name.textContent = shortLabel(app.name, 20);

		const value = document.createElement('span');
		value.className = 'legend-val';
		value.textContent = `${formatDuration(app.total)} • ${appPercent}%`;

		left.appendChild(swatch);
		left.appendChild(name);
		head.appendChild(left);
		head.appendChild(value);
		item.appendChild(head);

		if (hasChildren) {
			head.addEventListener('click', () => {
				if (state.expandedLegendKeys.has(legendKey))
					state.expandedLegendKeys.delete(legendKey);
				else
					state.expandedLegendKeys.add(legendKey);

				renderSelectedLegend(targetEl, apps, baseTotal);
			});
		}

		if (hasChildren && isExpanded) {
			const children = document.createElement('div');
			children.className = 'legend-children';

			for (const child of app.children) {
				const row = document.createElement('div');
				row.className = 'legend-child-row';

				const childName = document.createElement('span');
				childName.className = 'legend-child-name';
				childName.title = child.name;
				childName.textContent = `↳ ${shortLabel(child.name, 24)}`;

				const childVal = document.createElement('span');
				childVal.className = 'legend-child-val';
				childVal.textContent = formatDuration(child.seconds);

				row.appendChild(childName);
				row.appendChild(childVal);
				children.appendChild(row);
			}

			item.appendChild(children);
		}

		targetEl.appendChild(item);
	});
}

function renderSelectedDaySection(stats) {
	const appRows = stats.apps.slice(0, 6);
	const items = appRows.map(row => ({ name: row.name, seconds: row.total }));
	const wrap = q('selectedDonutWrap');
	const legend = q('selectedLegend');
	const empty = q('selectedEmpty');
	const subtitle = q('selectedSubtitle');

	if (subtitle) {
		subtitle.textContent = state.selectedDate
			? `Usage breakdown for ${state.selectedDate}.`
			: 'Navigate day by day to inspect app distribution.';
	}

	if (!items.length) {
		if (wrap)
			wrap.innerHTML = makeDonutMarkup([], 'Selected Day', 0);
		if (legend)
			legend.innerHTML = '';
		if (empty)
			empty.hidden = false;
		return;
	}

	if (empty)
		empty.hidden = true;

	if (wrap)
		wrap.innerHTML = makeDonutMarkup(items, 'Selected Day', stats.totalSeconds);
	renderSelectedLegend(legend, appRows, stats.totalSeconds);
}

function formatDateLabel(date, todayDate) {
	if (!date)
		return '--/--/----';

	const dt = dateFromIso(date);
	if (!dt)
		return date;

	const weekday = dt.toLocaleDateString(undefined, { weekday: 'short' });
	const [year, month, day] = date.split('-');
	const pretty = `${weekday} ${day}/${month}/${year}`;
	return date === todayDate ? `${pretty} (Today)` : pretty;
}

function renderDateNavigator() {
	const label = q('selectedDateLabel');
	const prevBtn = q('prevDateBtn');
	const nextBtn = q('nextDateBtn');

	if (!label || !prevBtn || !nextBtn)
		return;

	if (!state.dates.length || !state.selectedDate) {
		label.textContent = '--/--/----';
		prevBtn.disabled = true;
		nextBtn.disabled = true;
		return;
	}

	const idx = state.dates.indexOf(state.selectedDate);
	label.textContent = formatDateLabel(state.selectedDate, state.todayDate);
	prevBtn.disabled = idx <= 0;
	nextBtn.disabled = idx < 0 || idx >= state.dates.length - 1;
}

function renderTrendBars(trendRows) {
	const bars = q('dayBars');
	const empty = q('trendEmpty');
	const subtitle = q('trendSubtitle');

	if (!bars)
		return;

	bars.innerHTML = '';
	if (!trendRows.length) {
		if (empty)
			empty.hidden = false;
		if (subtitle)
			subtitle.textContent = 'Not enough daily data yet to draw a trend.';
		return;
	}

	if (empty)
		empty.hidden = true;

	if (subtitle)
		subtitle.textContent = `Showing ${trendRows.length} day${trendRows.length > 1 ? 's' : ''} of tracked activity (scale: 15h max).`;

	for (const row of trendRows) {
		const line = document.createElement('div');
		line.className = 'bar-col';
		if (row.date === state.selectedDate)
			line.classList.add('is-selected');
		line.title = `${row.date} - ${formatDuration(row.totalSeconds)}`;

		const val = document.createElement('div');
		val.className = 'bar-col-val';
		val.textContent = formatDuration(row.totalSeconds);

		const track = document.createElement('div');
		track.className = 'bar-col-track';

		const fill = document.createElement('div');
		fill.className = 'bar-col-fill';
		const scaledPercent = Math.min(100, Math.round((row.totalSeconds / TREND_SCALE_MAX_SECONDS) * 100));
		fill.style.height = row.totalSeconds > 0
			? `${Math.max(6, scaledPercent)}%`
			: '0%';

		const date = document.createElement('div');
		date.className = 'bar-col-date';
		date.textContent = row.date.slice(5);

		track.appendChild(fill);
		line.appendChild(val);
		line.appendChild(track);
		line.appendChild(date);
		bars.appendChild(line);
	}
}

function renderMetrics(todayStats, selectedStats, selectedDate, todayDate) {
	const total = todayStats.totalSeconds;
	const topApp = todayStats.apps[0] || null;
	const domainTotal = todayStats.domains.reduce((sum, row) => sum + row.seconds, 0);
	const webShare = total > 0 ? Math.round((domainTotal / total) * 100) : 0;
	const entities = selectedStats.apps.length + selectedStats.domains.length;

	q('metricTotal').textContent = formatDuration(total);
	q('metricTopApp').textContent = topApp ? shortLabel(topApp.name, 16) : '-';
	q('metricTopAppTime').textContent = topApp ? formatDuration(topApp.total) : '0m';
	q('metricWebShare').textContent = `${webShare}%`;
	q('metricEntities').textContent = String(entities);

	if (selectedDate !== todayDate) {
		q('metricEntities').title = `Entities for ${selectedDate}`;
	} else {
		q('metricEntities').title = 'Entities for today';
	}
}

function setStatus(text) {
	const status = q('status');
	if (!status)
		return;

	if (!text) {
		status.textContent = '';
		status.classList.remove('show');
		return;
	}

	status.textContent = text;
	status.classList.add('show');
}

function renderLastUpdate() {
	const now = new Date();
	const formatted = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
	q('lastUpdate').textContent = `Last updated: ${formatted}`;
}

async function fetchJson(url) {
	const res = await fetch(url, { cache: 'no-store' });
	if (!res.ok)
		throw new Error(`request failed (${res.status}) for ${url}`);
	return res.json();
}

function ensureTodayInDates(dates, todayDate) {
	const merged = Array.from(new Set([todayDate, ...dates]));
	return merged.sort((a, b) => (a < b ? -1 : 1));
}

function clampTrendWindow(dates) {
	if (dates.length <= TREND_DAYS_LIMIT)
		return dates;
	return dates.slice(dates.length - TREND_DAYS_LIMIT);
}

async function loadTrendRows(dates, todayDate, selectedDate) {
	const recentWindow = buildRecentDateWindow(todayDate, DUMMY_DAYS_BEFORE_TODAY);
	const recentTracked = clampTrendWindow(dates).filter(date => date >= recentWindow[0]);

	const merged = Array.from(new Set([...recentWindow, ...recentTracked]));
	if (selectedDate && !merged.includes(selectedDate))
		merged.push(selectedDate);

	const list = merged.sort((a, b) => (a < b ? -1 : 1));
	if (!list.length)
		return [];

	const raws = await Promise.all(
		list.map(date => fetchJson(`${DAILY_URL}?date=${encodeURIComponent(date)}`))
	);

	return list.map((date, idx) => ({
		date,
		totalSeconds: normalizeStats(raws[idx]).totalSeconds,
	}));
}

async function loadDashboardData() {
	const [todayRaw, dateRaw] = await Promise.all([
		fetchJson(`${DAILY_URL}?date=today`),
		fetchJson(DAILY_DATES_URL),
	]);

	const todayDate = (todayRaw && typeof todayRaw.date === 'string') ? todayRaw.date : localDateIso();
	const todayStats = normalizeStats(todayRaw);
	const dateList = ensureTodayInDates(normalizeDateList(dateRaw), todayDate);

	let selectedDate = state.selectedDate;
	if (!selectedDate || !dateList.includes(selectedDate))
		selectedDate = dateList.find(d => d !== todayDate) || todayDate;

	const selectedRaw = selectedDate === todayDate
		? todayRaw
		: await fetchJson(`${DAILY_URL}?date=${encodeURIComponent(selectedDate)}`);
	const trendRows = await loadTrendRows(dateList, todayDate, selectedDate);

	return {
		todayDate,
		todayStats,
		dateList,
		selectedDate,
		trendRows,
		selectedStats: normalizeStats(selectedRaw),
	};
}

async function refreshDashboard() {
	try {
		const data = await loadDashboardData();
		const previousSelectedDate = state.selectedDate;
		if (previousSelectedDate && previousSelectedDate !== data.selectedDate)
			state.expandedLegendKeys.clear();

		state.todayDate = data.todayDate;
		state.selectedDate = data.selectedDate;
		state.dates = data.dateList;
		state.trendRows = data.trendRows;

		renderDateNavigator();
		renderSelectedDaySection(data.selectedStats);
		renderTrendBars(data.trendRows);
		renderMetrics(data.todayStats, data.selectedStats, data.selectedDate, data.todayDate);
		renderLastUpdate();
		setStatus('');
	} catch (err) {
		console.error('[Dashboard] Failed to refresh', err);
		setStatus('Could not load daily tracker data. Ensure the local server is running.');
	}
}

function setup() {
	const refreshBtn = q('refreshBtn');
	if (refreshBtn)
		refreshBtn.addEventListener('click', refreshDashboard);

	const prevBtn = q('prevDateBtn');
	const nextBtn = q('nextDateBtn');

	if (prevBtn) {
		prevBtn.addEventListener('click', () => {
			const idx = state.dates.indexOf(state.selectedDate);
			if (idx > 0) {
				state.selectedDate = state.dates[idx - 1];
				refreshDashboard();
			}
		});
	}

	if (nextBtn) {
		nextBtn.addEventListener('click', () => {
			const idx = state.dates.indexOf(state.selectedDate);
			if (idx >= 0 && idx < state.dates.length - 1) {
				state.selectedDate = state.dates[idx + 1];
				refreshDashboard();
			}
		});
	}

	refreshDashboard();
	setInterval(refreshDashboard, REFRESH_MS);
}

setup();
