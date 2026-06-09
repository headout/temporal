package cache

import (
	"context"
	"encoding/json"
	"time"

	"github.com/redis/go-redis/v9"
	"go.temporal.io/server/common/log"
	"go.temporal.io/server/common/log/tag"
	"go.temporal.io/server/common/persistence/visibility/store"
)

type redisCache struct {
	client *redis.Client
	ttl    time.Duration
	logger log.Logger
}

func NewRedisVisibilityCache(
	endpoints []string,
	password string,
	db int,
	ttl time.Duration,
	maxRetries int,
	poolSize int,
	logger log.Logger,
) (store.VisibilityCache, error) {
	if len(endpoints) == 0 {
		endpoints = []string{"localhost:6379"}
	}

	client := redis.NewClient(&redis.Options{
		Addr:       endpoints[0],
		Password:   password,
		DB:         db,
		MaxRetries: maxRetries,
		PoolSize:   poolSize,
	})

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	if err := client.Ping(ctx).Err(); err != nil {
		return nil, err
	}

	return &redisCache{
		client: client,
		ttl:    ttl,
		logger: logger,
	}, nil
}

func (c *redisCache) Get(ctx context.Context, key string) (*store.InternalGetWorkflowExecutionResponse, bool) {
	data, err := c.client.Get(ctx, key).Bytes()
	if err != nil {
		if err == redis.Nil {
			return nil, false
		}
		c.logger.Error("Failed to get from Redis cache", tag.Error(err), tag.Key(key))
		return nil, false
	}

	var resp store.InternalGetWorkflowExecutionResponse
	if err := json.Unmarshal(data, &resp); err != nil {
		c.logger.Error("Failed to unmarshal cached value", tag.Error(err), tag.Key(key))
		return nil, false
	}

	return &resp, true
}

func (c *redisCache) Put(ctx context.Context, key string, value *store.InternalGetWorkflowExecutionResponse) error {
	data, err := json.Marshal(value)
	if err != nil {
		c.logger.Error("Failed to marshal value for cache", tag.Error(err), tag.Key(key))
		return err
	}

	if err := c.client.Set(ctx, key, data, c.ttl).Err(); err != nil {
		c.logger.Error("Failed to put to Redis cache", tag.Error(err), tag.Key(key))
		return err
	}

	return nil
}

func (c *redisCache) GetCount(ctx context.Context, key string) (*store.InternalCountExecutionsResponse, bool) {
	data, err := c.client.Get(ctx, key).Bytes()
	if err != nil {
		if err == redis.Nil {
			return nil, false
		}
		c.logger.Error("Failed to get count from Redis cache", tag.Error(err), tag.Key(key))
		return nil, false
	}

	var resp store.InternalCountExecutionsResponse
	if err := json.Unmarshal(data, &resp); err != nil {
		c.logger.Error("Failed to unmarshal cached count value", tag.Error(err), tag.Key(key))
		return nil, false
	}

	return &resp, true
}

func (c *redisCache) PutCount(ctx context.Context, key string, value *store.InternalCountExecutionsResponse) error {
	data, err := json.Marshal(value)
	if err != nil {
		c.logger.Error("Failed to marshal count value for cache", tag.Error(err), tag.Key(key))
		return err
	}

	if err := c.client.Set(ctx, key, data, c.ttl).Err(); err != nil {
		c.logger.Error("Failed to put count to Redis cache", tag.Error(err), tag.Key(key))
		return err
	}

	return nil
}

func (c *redisCache) GetList(ctx context.Context, key string) (*store.InternalListExecutionsResponse, bool) {
	data, err := c.client.Get(ctx, key).Bytes()
	if err != nil {
		if err == redis.Nil {
			return nil, false
		}
		c.logger.Error("Failed to get list from Redis cache", tag.Error(err), tag.Key(key))
		return nil, false
	}

	var resp store.InternalListExecutionsResponse
	if err := json.Unmarshal(data, &resp); err != nil {
		c.logger.Error("Failed to unmarshal cached list value", tag.Error(err), tag.Key(key))
		return nil, false
	}

	return &resp, true
}

func (c *redisCache) PutList(ctx context.Context, key string, value *store.InternalListExecutionsResponse) error {
	data, err := json.Marshal(value)
	if err != nil {
		c.logger.Error("Failed to marshal list value for cache", tag.Error(err), tag.Key(key))
		return err
	}

	if err := c.client.Set(ctx, key, data, c.ttl).Err(); err != nil {
		c.logger.Error("Failed to put list to Redis cache", tag.Error(err), tag.Key(key))
		return err
	}

	return nil
}

func (c *redisCache) Delete(ctx context.Context, key string) error {
	if err := c.client.Del(ctx, key).Err(); err != nil {
		c.logger.Error("Failed to delete from Redis cache", tag.Error(err), tag.Key(key))
		return err
	}
	return nil
}

func (c *redisCache) Close() error {
	return c.client.Close()
}
