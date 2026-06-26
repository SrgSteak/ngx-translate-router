import {
  Router,
  ROUTES,
  Route,
  DefaultExport,
  Routes,
  PRIMARY_OUTLET,
  ɵEmptyOutletComponent as EmptyOutletComponent,
} from "@angular/router";
import {
  Injector,
  Compiler,
  NgModuleFactory,
  PLATFORM_ID,
  inject,
  Injectable,
  EnvironmentInjector,
  runInInjectionContext,
} from "@angular/core";
import { isPlatformBrowser } from "@angular/common";
import { isObservable, Observable, firstValueFrom } from "rxjs";
import { LocalizeParser } from "./localize-router.parser";

@Injectable({ providedIn: "root" })
/**
 * LocalizedRouter
 * ----------------
 * TL;DR: extends the angular router, especially the parts responsible for loading
 * routes + child routes.
 *
 * This class extends Angular's Router to transparently localize routes that
 * are loaded lazily.
 *
 * Why does this exist?
 * ====================
 *
 * ngx-translate-router modifies route definitions by translating the `path`
 * properties before Angular starts matching URLs.
 *
 * Prior to Angular 21 the library could recursively walk the route tree,
 * including lazily loaded children, by accessing Router internals such as
 * `_loadedRoutes` and repeatedly calling `router.resetConfig()`.
 *
 * Angular 21 completely changed the lazy loading pipeline. Child routes are now
 * resolved asynchronously through RouterConfigLoader and no longer exist at the
 * time `resetConfig()` executes.
 *
 * As a consequence, lazily loaded routes remained untranslated which eventually
 * caused router failures during matching (for example
 * `containsEmptyPathMatches()` receiving an undefined route array).
 *
 * Instead of rewriting Angular's routing pipeline, this class intercepts the
 * lazy loading process itself.
 *
 * High level flow
 * ===============
 *
 * Angular navigation
 *          │
 *          ▼
 * RouterConfigLoader.loadChildren()
 *          │
 *          ▼
 * LocalizedRouter.customLoadChildren()
 *          │
 *          ├── load original lazy module/routes
 *          ├── translate child routes
 *          ├── return translated Routes
 *          ▼
 * Angular continues normally
 *
 * Angular itself never sees untranslated child routes.
 *
 * Design
 * ======
 *
 * The implementation overrides Angular's internal
 * RouterConfigLoader.loadChildren() method.
 *
 * This is intentionally done in one place instead of modifying the router state
 * afterwards via resetConfig(), because Angular now expects lazy routes to be
 * resolved through this loader.
 *
 * customLoadChildren() reproduces Angular's original implementation almost
 * verbatim while inserting the localization step immediately before the loaded
 * Routes are returned.
 *
 * Module-based lazy loading requires an additional trick:
 *
 *     injector.get(ROUTES)
 *
 * is intercepted so the ROUTES injection token returns already-localized route
 * definitions. This avoids having to patch Angular's module loading process.
 *
 * Caching
 * =======
 *
 * Angular expects concurrent requests for the same lazy route to share a single
 * Promise. childrenLoaders reproduces that behaviour using a WeakMap keyed by
 * Route.
 *
 * Compatibility
 * =============
 *
 * This implementation intentionally accesses Angular private APIs:
 *
 *   - navigationTransitions.configLoader
 *   - RouterConfigLoader.loadChildren()
 *   - _loadedRoutes
 *   - _loadedInjector
 *   - _loadedNgModuleFactory
 *
 * These APIs are not stable and may change between Angular releases.
 *
 * This file should therefore be considered an Angular-version compatibility
 * layer. If a future Angular update breaks lazy route localization, this is the
 * first file that should be investigated.
 *
 * Verified against:
 *
 *   Angular 21.x
 *
 * A cleaner implementation using only public Router APIs is planned for a
 * future major version once Angular exposes sufficient extension points.
 */
export class LocalizedRouter extends Router {
  private platformId = inject(PLATFORM_ID);
  private compiler = inject(Compiler);
  private localize = inject(LocalizeParser);
  private childrenLoaders = new WeakMap<Route, Promise<LoadedRouterConfig>>();
  onLoadStartListener?: (r: Route) => void;
  onLoadEndListener?: (r: Route) => void;
  constructor() {
    super();

    // get the configLoader in order to get access to loadChildren().
    const isBrowser = isPlatformBrowser(this.platformId);
    // __proto__ is needed for preloaded modules be doesn't work with SSR
    // @ts-ignore
    const configLoader = isBrowser
      ? (this as any).navigationTransitions.configLoader.__proto__
      : (this as any).navigationTransitions.configLoader;

    // Overrides default Angular RouterConfigLoader.loadChildren method so we can extend it
    configLoader.loadChildren = (
      parentInjector: Injector,
      route: any,
    ): Promise<LoadedRouterConfig> => {
      if (this.childrenLoaders.get(route)) {
        return this.childrenLoaders.get(route)!;
      } else if (route._loadedRoutes) {
        return Promise.resolve({
          routes: route._loadedRoutes,
          injector: route._loadedInjector,
        });
      }

      if (this.onLoadStartListener) {
        this.onLoadStartListener(route);
      }
      const loader = (async () => {
        try {
          const result = await this.customLoadChildren(
            route,
            this.compiler,
            parentInjector,
            this.onLoadEndListener,
          );
          route._loadedRoutes = result.routes;
          route._loadedInjector = result.injector;
          route._loadedNgModuleFactory = result.factory;
          return result;
        } finally {
          this.childrenLoaders.delete(route);
        }
      })();
      this.childrenLoaders.set(route, loader);
      return loader;
    };
  }

  async customLoadChildren(
    route: Route,
    compiler: Compiler,
    parentInjector: Injector,
    onLoadEndListener?: (r: Route) => void,
  ): Promise<LoadedRouterConfig> {
    const loaded = await wrapIntoPromise(
      runInInjectionContext(parentInjector, () => route.loadChildren!()),
    );
    const t = maybeUnwrapDefaultExport(loaded);

    let factoryOrRoutes: NgModuleFactory<any> | Routes;
    if (t instanceof NgModuleFactory || Array.isArray(t)) {
      factoryOrRoutes = t;
    } else {
      factoryOrRoutes = await compiler.compileModuleAsync(t);
    }

    if (onLoadEndListener) {
      onLoadEndListener(route);
    }

    let injector: EnvironmentInjector | undefined;
    let rawRoutes: Route[];
    let factory: NgModuleFactory<unknown> | undefined = undefined;
    if (Array.isArray(factoryOrRoutes)) {
      rawRoutes = this.localize.initChildRoutes([].concat(...factoryOrRoutes));
    } else {
      injector = factoryOrRoutes.create(parentInjector).injector;
      factory = factoryOrRoutes;
      // instead of having to overwrite the whole routes function stack,
      // we simply override the ROUTES injection token
      const getMethod = injector.get.bind(injector);
      injector["get"] = (token: any, notFoundValue: any, flags?: any) => {
        const getResult = getMethod(token, notFoundValue, flags);
        if (token === ROUTES) {
          return this.localize.initChildRoutes([].concat(...getResult));
        } else {
          return getResult;
        }
      };

      rawRoutes = injector
        .get(ROUTES, [], { optional: true, self: true })
        .flat();
    }
    const routes = rawRoutes.map(standardizeConfig);
    return { routes, injector, factory };
  }
}

export function standardizeConfig(r: Route): Route {
  const children = r.children && r.children.map(standardizeConfig);
  const c = children ? { ...r, children } : { ...r };
  if (
    !c.component &&
    !c.loadComponent &&
    (children || c.loadChildren) &&
    c.outlet &&
    c.outlet !== PRIMARY_OUTLET
  ) {
    c.component = EmptyOutletComponent;
  }
  return c;
}

export interface LoadedRouterConfig {
  routes: Route[];
  injector: EnvironmentInjector | undefined;
  factory?: NgModuleFactory<unknown>;
}

/**
 * see
 * @param value
 * @returns
 */
function isWrappedDefaultExport<T>(
  value: T | DefaultExport<T>,
): value is DefaultExport<T> {
  // We use `in` here with a string key `'default'`, because we expect `DefaultExport` objects to be
  // dynamically imported ES modules with a spec-mandated `default` key. Thus we don't expect that
  // `default` will be a renamed property.
  return value && typeof value === "object" && "default" in value;
}

function maybeUnwrapDefaultExport<T>(input: T | DefaultExport<T>): T {
  // As per `isWrappedDefaultExport`, the `default` key here is generated by the browser and not
  // subject to property renaming, so we reference it with bracket access.
  return isWrappedDefaultExport(input) ? input["default"] : input;
}

/**
 * see https://github.com/angular/angular/blob/main/packages/router/src/utils/collection.ts#L88
 * @param value
 * @returns
 */
export function wrapIntoPromise<T>(
  value: T | Promise<T> | Observable<T>,
): Promise<T> {
  if (isObservable(value)) {
    return firstValueFrom(value);
  }
  return Promise.resolve(value);
}