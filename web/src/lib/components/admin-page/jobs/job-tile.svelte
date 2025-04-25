<script lang="ts">
  import Badge from '$lib/components/elements/badge.svelte';
  import CircleIconButton from '$lib/components/elements/buttons/circle-icon-button.svelte';
  import Icon from '$lib/components/elements/icon.svelte';
  import { locale } from '$lib/stores/preferences.store';
  import { JobCommand, type JobCommandDto, type JobCountsDto, type QueueStatusDto } from '@immich/sdk';
  import {
    mdiAlertCircle,
    mdiAllInclusive,
    mdiClose,
    mdiFastForward,
    mdiImageRefreshOutline,
    mdiPause,
    mdiPlay,
    mdiSelectionSearch,
  } from '@mdi/js';
  import { type Component } from 'svelte';
  import { t } from 'svelte-i18n';
  import JobTileButton from './job-tile-button.svelte';

  interface Props {
    title: string;
    subtitle: string | undefined;
    description: Component | undefined;
    jobCounts: JobCountsDto;
    icon: string;
    disabled?: boolean;
    allText: string | undefined;
    refreshText: string | undefined;
    missingText: string;
    onCommand: (command: JobCommandDto) => void;
  }

  let {
    title,
    subtitle,
    description,
    jobCounts,
    icon,
    disabled = false,
    allText,
    refreshText,
    missingText,
    onCommand,
  }: Props = $props();

  let waitingCount = $derived(jobCounts.waiting);
  let isIdle = $derived(jobCounts.active === 0);
  let multipleButtons = $derived(allText || refreshText);

  const commonClasses = 'flex place-items-center justify-between w-full py-2 sm:py-4 pr-4 pl-6';
</script>

<div
  class="flex flex-col overflow-hidden rounded-2xl bg-gray-100 dark:bg-immich-dark-gray sm:flex-row sm:rounded-[35px]"
>
  <div class="flex w-full flex-col">
    <div class="flex flex-col gap-2 p-5 sm:p-7 md:p-9">
      <div class="flex items-center gap-4 text-xl font-semibold text-immich-primary dark:text-immich-dark-primary">
        <span class="flex items-center gap-2">
          <Icon path={icon} size="1.25em" class="hidden shrink-0 sm:block" />
          {title.toUpperCase()}
        </span>
        <div class="flex gap-2">
          {#if jobCounts.failed > 0}
            <Badge color="primary">
              <div class="flex flex-row gap-1">
                <span class="text-sm">
                  {$t('admin.jobs_failed', { values: { jobCount: jobCounts.failed.toLocaleString($locale) } })}
                </span>
                <CircleIconButton
                  color="primary"
                  icon={mdiClose}
                  title={$t('clear_message')}
                  size="12"
                  padding="1"
                  onclick={() => onCommand({ command: JobCommand.Clear, force: false })}
                />
              </div>
            </Badge>
          {/if}
        </div>
      </div>

      {#if subtitle}
        <div class="whitespace-pre-line text-sm dark:text-white">{subtitle}</div>
      {/if}

      {#if description}
        {@const SvelteComponent = description}
        <div class="text-sm dark:text-white">
          <SvelteComponent />
        </div>
      {/if}

      <div class="mt-2 flex w-full max-w-md flex-col sm:flex-row">
        <div
          class="{commonClasses} rounded-t-lg bg-immich-primary text-white dark:bg-immich-dark-primary dark:text-immich-dark-gray sm:rounded-l-lg sm:rounded-r-none"
        >
          <p>{$t('active')}</p>
          <p class="text-2xl">
            {jobCounts.active.toLocaleString($locale)}
          </p>
        </div>

        <div
          class="{commonClasses} flex-row-reverse rounded-b-lg bg-gray-200 text-immich-dark-bg dark:bg-gray-700 dark:text-immich-gray sm:rounded-l-none sm:rounded-r-lg"
        >
          <p class="text-2xl">
            {waitingCount.toLocaleString($locale)}
          </p>
          <p>{$t('waiting')}</p>
        </div>
      </div>
    </div>
  </div>
  <div class="flex w-full flex-row overflow-hidden sm:w-32 sm:flex-col">
    {#if jobCounts.active > 0 || jobCounts.waiting > 0}
      <JobTileButton color="gray" onClick={() => onCommand({ command: JobCommand.Clear, force: false })}>
        <Icon path={mdiClose} size="24" />
        {$t('clear').toUpperCase()}
      </JobTileButton>
    {:else if !disabled && multipleButtons && isIdle}
      {#if allText}
        <JobTileButton color="dark-gray" onClick={() => onCommand({ command: JobCommand.Start, force: true })}>
          <Icon path={mdiAllInclusive} size="24" />
          {allText}
        </JobTileButton>
      {/if}
      {#if refreshText}
        <JobTileButton color="gray" onClick={() => onCommand({ command: JobCommand.Start, force: undefined })}>
          <Icon path={mdiImageRefreshOutline} size="24" />
          {refreshText}
        </JobTileButton>
      {/if}
      <JobTileButton color="light-gray" onClick={() => onCommand({ command: JobCommand.Start, force: false })}>
        <Icon path={mdiSelectionSearch} size="24" />
        {missingText}
      </JobTileButton>
    {/if}

    {#if !disabled && !multipleButtons && isIdle}
      <JobTileButton color="light-gray" onClick={() => onCommand({ command: JobCommand.Start, force: false })}>
        <Icon path={mdiPlay} size="48" />
        {missingText}
      </JobTileButton>
    {/if}
  </div>
</div>
