import { SonosNamespace } from '../namespace';

export class HomeTheaterNamespace extends SonosNamespace<any> {
  constructor(api: any) {
    super(api, 'homeTheater', 'homeTheaterStatus', 'playerId');
  }

  async loadHomeTheaterPlayback(playerId: string): Promise<void> {
    await this.api.sendCommand(this.namespace, 'loadHomeTheaterPlayback', undefined, { playerId });
  }
}
