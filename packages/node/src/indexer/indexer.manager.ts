// Copyright 2020-2024 SubQuery Pte Ltd authors & contributors
// SPDX-License-Identifier: GPL-3.0

import { Injectable } from '@nestjs/common';
import { ApiPromise } from '@polkadot/api';
import { RuntimeVersion } from '@polkadot/types/interfaces';
import {
  isBlockHandlerProcessor,
  isCallHandlerProcessor,
  isEventHandlerProcessor,
  isCustomDs,
  isRuntimeDs,
  SubstrateCustomDataSource,
  SubstrateHandlerKind,
  SubstrateRuntimeHandlerInputMap,
} from '@subql/common-substrate';
import {
  NodeConfig,
  profiler,
  SandboxService,
  IndexerSandbox,
  ProcessBlockResponse,
  BaseIndexerManager,
  IBlock,
  getLogger,
} from '@subql/node-core';
import {
  LightSubstrateEvent,
  SubstrateBlock,
  SubstrateBlockFilter,
  SubstrateDatasource,
  SubstrateEvent,
  SubstrateExtrinsic,
} from '@subql/types';
import { SubstrateProjectDs } from '../configure/SubqueryProject';
import * as SubstrateUtil from '../utils/substrate';
import { ApiService as SubstrateApiService } from './api.service';
import { DsProcessorService } from './ds-processor.service';
import { DynamicDsService } from './dynamic-ds.service';
import { ApiAt, BlockContent, isFullBlock, LightBlockContent } from './types';
import { UnfinalizedBlocksService } from './unfinalizedBlocks.service';

const logger = getLogger('indexer');

@Injectable()
export class IndexerManager extends BaseIndexerManager<
  ApiPromise,
  ApiAt,
  BlockContent | LightBlockContent,
  SubstrateApiService,
  SubstrateDatasource,
  SubstrateCustomDataSource,
  typeof FilterTypeMap,
  typeof ProcessorTypeMap,
  SubstrateRuntimeHandlerInputMap
> {
  protected isRuntimeDs = isRuntimeDs;
  protected isCustomDs = isCustomDs;

  constructor(
    apiService: SubstrateApiService,
    nodeConfig: NodeConfig,
    sandboxService: SandboxService<ApiAt, ApiPromise>,
    dsProcessorService: DsProcessorService,
    dynamicDsService: DynamicDsService,
    unfinalizedBlocksService: UnfinalizedBlocksService,
  ) {
    super(
      apiService,
      nodeConfig,
      sandboxService,
      dsProcessorService,
      dynamicDsService,
      unfinalizedBlocksService,
      FilterTypeMap,
      ProcessorTypeMap,
    );
  }

  @profiler()
  async indexBlock(
    block: IBlock<BlockContent | LightBlockContent>,
    dataSources: SubstrateDatasource[],
    runtimeVersion?: RuntimeVersion,
  ): Promise<ProcessBlockResponse> {
    return super.internalIndexBlock(block, dataSources, () =>
      this.getApi(block.block, runtimeVersion),
    );
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  private async getApi(
    block: LightBlockContent | BlockContent,
    runtimeVersion?: RuntimeVersion,
  ): Promise<ApiAt> {
    return this.apiService.getPatchedApi(
      block.block.block.header,
      runtimeVersion,
    );
  }

  protected async indexBlockData(
    blockContent: LightBlockContent | BlockContent,
    dataSources: SubstrateProjectDs[],
    getVM: (d: SubstrateProjectDs) => Promise<IndexerSandbox>,
  ): Promise<void> {
    if (isFullBlock(blockContent)) {
      const { block, events, extrinsics } = blockContent;
      await this.indexBlockContent(block, dataSources, getVM);

      // Group the events so they only need to be iterated over a single time
      const groupedEvents = events.reduce(
        (acc, evt, idx) => {
          if (evt.phase.isInitialization) {
            acc.init.push(evt);
          } else if (evt.phase.isFinalization) {
            acc.finalize.push(evt);
          } else if (evt.extrinsic?.idx) {
            const idx = evt.extrinsic.idx;
            acc[idx] ??= [];
            acc[idx].push(evt);
          } else if (!evt.phase.isApplyExtrinsic) {
            logger.warn(
              `Unrecognized event type, skipping. block="${block.block.header.number.toNumber()}" eventIdx="${idx}"`,
            );
          }
          return acc;
        },
        { init: [], finalize: [] } as Record<
          number | 'init' | 'finalize',
          SubstrateEvent[]
        >,
      );

      // Run initialization events
      for (const event of groupedEvents.init) {
        await this.indexEvent(event, dataSources, getVM);
      }

      for (const extrinsic of extrinsics) {
        await this.indexExtrinsic(extrinsic, dataSources, getVM);

        // Process extrinsic events
        const extrinsicEvents = (groupedEvents[extrinsic.idx] ?? []).sort(
          (a, b) => a.idx - b.idx,
        );

        for (const event of extrinsicEvents) {
          await this.indexEvent(event, dataSources, getVM);
        }
      }

      // Run finalization events
      for (const event of groupedEvents.finalize) {
        await this.indexEvent(event, dataSources, getVM);
      }
    } else {
      for (const event of blockContent.events) {
        await this.indexEvent(event, dataSources, getVM);
      }
    }
  }

  private async indexBlockContent(
    block: SubstrateBlock,
    dataSources: SubstrateProjectDs[],
    getVM: (d: SubstrateProjectDs) => Promise<IndexerSandbox>,
  ): Promise<void> {
    for (const ds of dataSources) {
      await this.indexData(SubstrateHandlerKind.Block, block, ds, getVM);
    }
  }

  private async indexExtrinsic(
    extrinsic: SubstrateExtrinsic,
    dataSources: SubstrateProjectDs[],
    getVM: (d: SubstrateProjectDs) => Promise<IndexerSandbox>,
  ): Promise<void> {
    for (const ds of dataSources) {
      await this.indexData(SubstrateHandlerKind.Call, extrinsic, ds, getVM);
    }
  }

  private async indexEvent(
    event: SubstrateEvent | LightSubstrateEvent,
    dataSources: SubstrateProjectDs[],
    getVM: (d: SubstrateProjectDs) => Promise<IndexerSandbox>,
  ): Promise<void> {
    for (const ds of dataSources) {
      await this.indexData(SubstrateHandlerKind.Event, event, ds, getVM);
    }
  }

  protected async prepareFilteredData<T = any>(
    kind: SubstrateHandlerKind,
    data: T,
  ): Promise<T> {
    // Substrate doesn't need to do anything here
    return Promise.resolve(data);
  }
}

const ProcessorTypeMap = {
  [SubstrateHandlerKind.Block]: isBlockHandlerProcessor,
  [SubstrateHandlerKind.Event]: isEventHandlerProcessor,
  [SubstrateHandlerKind.Call]: isCallHandlerProcessor,
};

const FilterTypeMap = {
  [SubstrateHandlerKind.Block]: (
    block: SubstrateBlock,
    filter?: SubstrateBlockFilter,
  ) => !!SubstrateUtil.filterBlock(block, filter),
  [SubstrateHandlerKind.Event]: SubstrateUtil.filterEvent,
  [SubstrateHandlerKind.Call]: SubstrateUtil.filterExtrinsic,
};
