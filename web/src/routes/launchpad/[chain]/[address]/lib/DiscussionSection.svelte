<script lang="ts">
	import { t } from '$lib/i18n';
	import { shortAddr } from '$lib/formatters';

	type Comment = {
		id: number;
		launch_address?: string;
		chain_id?: number;
		wallet_address: string;
		message: string;
		created_at: string;
	};

	let {
		comments,
		commentsLoading,
		commentText = $bindable(''),
		isPostingComment,
		userAddress,
		onPost,
		onConnectWallet,
	}: {
		comments: Comment[];
		commentsLoading: boolean;
		commentText: string;
		isPostingComment: boolean;
		userAddress: string | null;
		onPost: () => Promise<void>;
		onConnectWallet: () => Promise<void>;
	} = $props();

	function relativeTime(iso: string): string {
		const diff = Date.now() - new Date(iso).getTime();
		if (diff < 60000) return $t('lpd.justNow');
		if (diff < 3600000) return $t('lpd.minutesAgo').replace('{n}', String(Math.floor(diff / 60000)));
		if (diff < 86400000) return $t('lpd.hoursAgo').replace('{n}', String(Math.floor(diff / 3600000)));
		return $t('lpd.daysAgo').replace('{n}', String(Math.floor(diff / 86400000)));
	}
</script>

<!-- Discussion / Comments -->
<div class="card p-6 mb-4">
	<h3 class="syne font-bold text-white mb-4">{$t('lpd.discussion')}</h3>

	<!-- Post new comment -->
	{#if userAddress}
		<div class="border-b border-white/[0.06] pb-4 mb-4">
			<textarea
				class="input-field resize-y min-h-12 max-h-[120px]"
				rows="2"
				maxlength="500"
				placeholder={$t('lpd.commentPlaceholder')}
				bind:value={commentText}
			></textarea>
			<div class="flex justify-between items-center mt-2">
				<span class="text-gray-600 text-xs2 font-mono">{commentText.length}/500</span>
				<button
					onclick={onPost}
					disabled={isPostingComment || !commentText.trim()}
					class="btn-primary px-4 py-1.5 text-xs cursor-pointer"
				>
					{isPostingComment ? $t('lpd.posting') : $t('lpd.postComment')}
				</button>
			</div>
		</div>
	{:else}
		<div class="text-center py-3 mb-4 border border-dashed border-gray-700 rounded-lg">
			<p class="text-gray-500 text-xs font-mono mb-2">{$t('lpd.connectToComment')}</p>
			<button
				onclick={onConnectWallet}
				class="btn-primary px-4 py-1.5 text-xs cursor-pointer"
			>
				{$t('lpd.connectAndComment')}
			</button>
		</div>
	{/if}

	<!-- Comments list -->
	{#if commentsLoading}
		<div class="text-gray-500 text-xs font-mono text-center py-4">{$t('status.loading')}...</div>
	{:else if comments.length === 0}
		<p class="text-gray-600 font-mono text-sm italic text-center py-4">{$t('lpd.noComments')}</p>
	{:else}
		<div class="flex flex-col gap-0">
			{#each comments as comment}
				<div class="py-3 border-b border-[var(--border-subtle)] last:border-b-0">
					<div class="flex justify-between items-center">
						<span class="text-cyan-400 text-xs font-mono font-semibold">{shortAddr(comment.wallet_address)}</span>
						<span class="text-gray-600 text-xs2 font-mono">{relativeTime(comment.created_at)}</span>
					</div>
					<p class="text-gray-300 text-sm font-mono leading-relaxed mt-1 whitespace-pre-line break-words">{comment.message}</p>
				</div>
			{/each}
		</div>
	{/if}
</div>
