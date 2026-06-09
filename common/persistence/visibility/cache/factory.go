package cache

import (
	"fmt"

	"go.temporal.io/server/common/config"
	"go.temporal.io/server/common/log"
	"go.temporal.io/server/common/persistence/visibility/store"
)

func NewVisibilityCache(cfg *config.VisibilityCacheConfig, logger log.Logger) (store.VisibilityCache, error) {
	if cfg == nil || !cfg.Enabled {
		return NewNoOpCache(), nil
	}

	if err := cfg.Validate(); err != nil {
		return nil, fmt.Errorf("invalid visibility cache config: %w", err)
	}

	switch cfg.Type {
	case config.VisibilityCacheTypeInMemory:
		maxSize := cfg.InMemory.MaxSize
		if maxSize <= 0 {
			maxSize = 10000
		}
		ttl := cfg.InMemory.TTL
		if ttl <= 0 {
			ttl = 0
		}
		return NewInMemoryVisibilityCache(maxSize, ttl), nil

	case config.VisibilityCacheTypeRedis:
		maxRetries := cfg.Redis.MaxRetries
		if maxRetries <= 0 {
			maxRetries = 3
		}
		poolSize := cfg.Redis.PoolSize
		if poolSize <= 0 {
			poolSize = 10
		}
		ttl := cfg.Redis.TTL
		if ttl <= 0 {
			ttl = 0
		}
		return NewRedisVisibilityCache(
			cfg.Redis.Endpoints,
			cfg.Redis.Password,
			cfg.Redis.DB,
			ttl,
			maxRetries,
			poolSize,
			logger,
		)

	default:
		return nil, fmt.Errorf("unknown visibility cache type: %s", cfg.Type)
	}
}
