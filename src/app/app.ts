import { Component, computed, effect, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { SailpointPluginService } from '@core';
import { Paginator } from '@sailpoint/angular-sdk';
import {
  IdentitiesService,
  type Identity,
} from '@sailpoint/angular-sdk/identities';
import { firstValueFrom } from 'rxjs';

import { AvatarModule } from 'primeng/avatar';
import { MessageModule } from 'primeng/message';
import { SelectModule } from 'primeng/select';
import { SkeletonModule } from 'primeng/skeleton';
import { TagModule } from 'primeng/tag';

interface IdentityOption {
  id: string;
  name: string;
}

interface ChangeRow {
  field: string;
  current: string;
  proposed: string;
  status: 'changed' | 'unchanged';
}

interface AccessImpact {
  name: string;
  impact: 'keep' | 'add' | 'review';
}

@Component({
  selector: 'app-root',
  imports: [
    AvatarModule,
    FormsModule,
    MessageModule,
    SelectModule,
    SkeletonModule,
    TagModule,
  ],
  providers: [IdentitiesService],
  templateUrl: './app.html',
  styleUrl: './app.scss',
})
export class App {
  protected readonly plugin = inject(SailpointPluginService);
  private readonly identitiesSvc = inject(IdentitiesService);

  protected readonly identities = signal<Identity[]>([]);
  protected readonly loading = signal(false);
  protected readonly error = signal('');

  protected readonly selectedIdentityId = signal('');
  protected readonly proposedDepartmentName = signal('');
  protected readonly simulationRun = signal(false);

  private requested = false;

  constructor() {
    effect(() => {
      if (this.plugin.apiReady() && !this.requested) {
        this.requested = true;
        void this.loadIdentities();
      }
    });
  }

  /**
   * Identities available for selection.
   *
   * The SailPoint Identity type allows id to be undefined, so identities
   * without an ID are excluded from the dropdown.
   */
  protected readonly identityOptions = computed<IdentityOption[]>(() =>
    this.identities()
      .filter((identity) => typeof identity.id === 'string')
      .map((identity) => ({
        id: identity.id as string,
        name: identity.name,
      }))
      .sort((a, b) => a.name.localeCompare(b.name)),
  );

  /**
   * Build a unique list of departments using identity data already
   * returned from SailPoint.
   */
  protected readonly departmentOptions = computed<string[]>(() => {
    const departments = this.identities()
      .map((identity) => this.attr(identity, 'department'))
      .filter((department) => department !== '-');

    return [...new Set(departments)].sort();
  });

  /**
   * Currently selected identity.
   */
  protected readonly selectedIdentity = computed<Identity | undefined>(() => {
    const id = this.selectedIdentityId();

    return this.identities().find((identity) => identity.id === id);
  });

  /**
   * Identities currently in the proposed destination department.
   *
   * Later, we can use these identities as the comparison population
   * for the real entitlement analysis.
   */
  protected readonly proposedPeers = computed<Identity[]>(() => {
    const department = this.proposedDepartmentName();

    if (!department) {
      return [];
    }

    return this.identities().filter(
      (identity) => this.attr(identity, 'department') === department,
    );
  });

  protected readonly proposedDepartment = computed<string>(
    () => this.proposedDepartmentName() || '-',
  );

  /**
   * Current-versus-proposed identity attributes.
   */
  protected readonly changes = computed<ChangeRow[]>(() => {
    const identity = this.selectedIdentity();
    const proposedDepartment = this.proposedDepartmentName();

    if (!identity || !proposedDepartment) {
      return [];
    }

    const currentDepartment = this.attr(identity, 'department');

    return [
      this.changeRow(
        'Department',
        currentDepartment,
        proposedDepartment,
      ),
      this.changeRow(
        'Manager',
        identity.managerRef?.name ?? 'No manager',
        'To be determined',
      ),
      this.changeRow(
        'Lifecycle State',
        this.attr(identity, 'cloudLifecycleState'),
        this.attr(identity, 'cloudLifecycleState'),
      ),
    ];
  });

  protected readonly changedItems = computed<ChangeRow[]>(() =>
    this.changes().filter((row) => row.status === 'changed'),
  );

  /**
   * Simple Hack Day access-impact preview.
   *
   * IMPORTANT:
   * These are illustrative access categories based on the department
   * transition. They are not actual entitlement recommendations yet.
   *
   * This can later be replaced with real SailPoint entitlement data
   * without changing the UI.
   */
  protected readonly accessImpact = computed<AccessImpact[]>(() => {
    const identity = this.selectedIdentity();
    const proposedDepartment = this.proposedDepartmentName();

    if (!identity || !proposedDepartment) {
      return [];
    }

    const currentDepartment = this.attr(identity, 'department');

    const impacts: AccessImpact[] = [];

    impacts.push({
      name: 'Baseline organizational access',
      impact: 'keep',
    });

    if (
      proposedDepartment !== '-' &&
      proposedDepartment !== currentDepartment
    ) {
      impacts.push({
        name: `${proposedDepartment} access`,
        impact: 'add',
      });
    }

    if (
      currentDepartment !== '-' &&
      currentDepartment !== proposedDepartment
    ) {
      impacts.push({
        name: `${currentDepartment} access`,
        impact: 'review',
      });
    }

    return impacts;
  });

  /**
   * A scenario is valid when:
   * - an identity is selected
   * - a destination department is selected
   * - the destination is different from the current department
   */
  protected readonly hasValidScenario = computed<boolean>(() => {
    const identity = this.selectedIdentity();
    const proposedDepartment = this.proposedDepartmentName();

    if (!identity || !proposedDepartment) {
      return false;
    }

    return this.attr(identity, 'department') !== proposedDepartment;
  });

  /**
   * Load identities from SailPoint.
   */
  protected async loadIdentities(): Promise<void> {
    this.loading.set(true);
    this.error.set('');

    try {
      const identities = await firstValueFrom(
        Paginator.paginate(
          (params) => this.identitiesSvc.listIdentitiesV1(params),
          { sorters: 'name' },
        ),
      );

      this.identities.set(identities);
    } catch (err) {
      this.error.set(this.formatApiError(err));
    } finally {
      this.loading.set(false);
    }
  }

  protected onIdentityChange(id: string | null): void {
    this.selectedIdentityId.set(id ?? '');
    this.simulationRun.set(false);
  }

  protected onDepartmentChange(department: string | null): void {
    this.proposedDepartmentName.set(department ?? '');
    this.simulationRun.set(false);
  }

  protected runSimulation(): void {
    if (!this.hasValidScenario()) {
      return;
    }

    this.simulationRun.set(true);
  }

  protected resetSimulation(): void {
    this.selectedIdentityId.set('');
    this.proposedDepartmentName.set('');
    this.simulationRun.set(false);
  }

  /**
   * Reads an identity attribute from the SailPoint attributes map.
   */
  protected attr(identity: Identity, key: string): string {
    const attributes = identity.attributes as
      | Record<string, unknown>
      | undefined;

    const value = attributes?.[key];

    if (typeof value === 'string' && value.trim()) {
      return value;
    }

    return '-';
  }

  protected initials(name: string): string {
    return name
      .split(' ')
      .filter(Boolean)
      .slice(0, 2)
      .map((part) => part[0].toUpperCase())
      .join('');
  }

  protected changeSeverity(
    status: ChangeRow['status'],
  ): 'warn' | 'secondary' {
    return status === 'changed' ? 'warn' : 'secondary';
  }

  private changeRow(
    field: string,
    current: string,
    proposed: string,
  ): ChangeRow {
    return {
      field,
      current,
      proposed,
      status: current === proposed ? 'unchanged' : 'changed',
    };
  }

  private formatApiError(err: unknown): string {
    return err instanceof Error
      ? `${err.name}: ${err.message}`
      : String(err);
  }
}