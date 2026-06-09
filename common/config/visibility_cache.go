package config

import "time"

type (
	VisibilityCacheConfig struct {
		Enabled        bool `yaml:"enabled"`
		CacheTTLSeconds int  `yaml:"cacheTTLSeconds"`
	}

	VisibilityCacheConfigLegacy struct {
		Enabled bool                       `yaml:"enabled"`
		Type    string                     `yaml:"type"`
		InMemory *InMemoryCacheConfig      `yaml:"inMemory"`
		Redis    *RedisCacheConfig         `yaml:"redis"`
	}

	InMemoryCacheConfig struct {
		MaxSize int           `yaml:"maxSize"`
		TTL     time.Duration `yaml:"ttl"`
	}

	RedisCacheConfig struct {
		Endpoints []string      `yaml:"endpoints"`
		Password  string        `yaml:"password"`
		DB        int           `yaml:"db"`
		TTL       time.Duration `yaml:"ttl"`
		MaxRetries int          `yaml:"maxRetries"`
		PoolSize   int          `yaml:"poolSize"`
	}
)

const (
	VisibilityCacheTypeInMemory = "inmemory"
	VisibilityCacheTypeRedis    = "redis"
)

func (c *VisibilityCacheConfig) Validate() error {
	return nil
}

func (c *VisibilityCacheConfigLegacy) Validate() error {
	if !c.Enabled {
		return nil
	}
	
	if c.Type != VisibilityCacheTypeInMemory && c.Type != VisibilityCacheTypeRedis {
		return ErrPersistenceConfig
	}
	
	if c.Type == VisibilityCacheTypeInMemory && c.InMemory == nil {
		return ErrPersistenceConfig
	}
	
	if c.Type == VisibilityCacheTypeRedis && c.Redis == nil {
		return ErrPersistenceConfig
	}
	
	return nil
}
