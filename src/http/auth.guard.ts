import { type CanActivate, type ExecutionContext, Inject, Injectable, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';

/**
 * Ponto de extensão de autenticação (seção 2 — não implementada, decisão
 * documentada no ARCHITECTURE.md).
 *
 * Desenho previsto: Keycloak no docker-compose, um client por provedor com
 * client_credentials; o guard valida o JWT (JWKS do realm, issuer, audience)
 * e a implementação de `ProviderIdentityPort` devolve o providerId do token
 * (claim `azp`). O use case então exige `command.providerId === identity`.
 */
export interface ProviderIdentity {
  providerId: string;
}

export interface ProviderIdentityPort {
  /** `undefined` = credencial ausente ou inválida. */
  identify(authorizationHeader: string | undefined): Promise<ProviderIdentity | undefined>;
}

export const PROVIDER_IDENTITY = Symbol('ProviderIdentityPort');

/** Implementação atual: aceita tudo. Trocar por um verificador OIDC. */
export class AllowAllProviderIdentity implements ProviderIdentityPort {
  async identify(): Promise<ProviderIdentity | undefined> {
    return { providerId: '*' };
  }
}

export const PUBLIC_ROUTE = 'public-route';
/** Rotas abertas mesmo com autenticação ligada (health checks, métricas). */
export const Public = () => SetMetadata(PUBLIC_ROUTE, true);

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    @Inject(PROVIDER_IDENTITY) private readonly identity: ProviderIdentityPort,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(PUBLIC_ROUTE, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;
    const req = context.switchToHttp().getRequest<{ headers: Record<string, string | undefined>; provider?: ProviderIdentity }>();
    const provider = await this.identity.identify(req.headers.authorization);
    if (!provider) return false;
    req.provider = provider;
    return true;
  }
}
