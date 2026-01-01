import { ContainerType, MusicService, PlaybackActions, PlayModes } from './types';

export class PlaybackActionsWrapper {
  constructor(private raw: PlaybackActions) {}

  get canSkipForward(): boolean {
    return this.raw.canSkipForward ?? this.raw.canSkip ?? false;
  }
  get canSkipBackward(): boolean {
    return this.raw.canSkipBack ?? this.raw.canSkipToPrevious ?? false;
  }
  get canPlay(): boolean {
    return this.raw.canPlay ?? false;
  }
  get canPause(): boolean {
    return this.raw.canPause ?? false;
  }
  get canStop(): boolean {
    return this.raw.canStop ?? false;
  }
}

export class PlayModesWrapper {
  constructor(public raw: PlayModes) {}

  get crossfade(): boolean | undefined {
    return this.raw.crossfade;
  }
  get repeat(): boolean | undefined {
    return this.raw.repeat;
  }
  get repeatOne(): boolean | undefined {
    return this.raw.repeatOne;
  }
  get shuffle(): boolean | undefined {
    return this.raw.shuffle;
  }
}

export function normalizeContainerType(containerType?: string): ContainerType | string | null {
  if (!containerType) return null;
  if ((Object.values(ContainerType) as string[]).includes(containerType)) {
    return containerType as ContainerType;
  }
  return containerType;
}

export function normalizeMusicService(serviceId?: string): MusicService | string | null {
  if (!serviceId) return null;
  if ((Object.values(MusicService) as string[]).includes(serviceId)) {
    return serviceId as MusicService;
  }
  return serviceId;
}
