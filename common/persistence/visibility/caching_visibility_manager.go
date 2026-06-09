package visibility

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"sync"
	"time"

	"go.temporal.io/server/api/visibilityservice/v1"
	"go.temporal.io/server/common/log"
	"go.temporal.io/server/common/log/tag"
	"go.temporal.io/server/common/metrics"
	"go.temporal.io/server/common/namespace"
	"go.temporal.io/server/common/persistence/visibility/manager"
)

const (
	countWorkflowExecutionsTTL = 20 * time.Second
	listWorkflowExecutionsTTL  = 15 * time.Second
	schedulerCountTTL          = 30 * time.Second
)

type cacheEntry struct {
	value     any
	expiresAt time.Time
}

type cachingVisibilityManager struct {
	delegate        manager.VisibilityManager
	cache           map[string]*cacheEntry
	mu              sync.RWMutex
	logger          log.Logger
	metricsHandler  metrics.Handler
	cacheHits       metrics.CounterIface
	cacheMisses     metrics.CounterIface
	cachingEnabled  bool
	defaultCacheTTL time.Duration
}

func NewCachingVisibilityManager(
	delegate manager.VisibilityManager,
	cachingEnabled bool,
	cacheTTLSeconds int,
	logger log.Logger,
	metricsHandler metrics.Handler,
) manager.VisibilityManager {
	if !cachingEnabled {
		return delegate
	}

	defaultTTL := 20 * time.Second
	if cacheTTLSeconds > 0 {
		defaultTTL = time.Duration(cacheTTLSeconds) * time.Second
	}

	cvm := &cachingVisibilityManager{
		delegate:        delegate,
		cache:           make(map[string]*cacheEntry),
		logger:          logger,
		metricsHandler:  metricsHandler,
		cachingEnabled:  cachingEnabled,
		defaultCacheTTL: defaultTTL,
	}

	if metricsHandler != nil {
		cvm.cacheHits = metricsHandler.Counter("temporal_visibility_cache_hits_total")
		cvm.cacheMisses = metricsHandler.Counter("temporal_visibility_cache_misses_total")
	}

	return cvm
}

func (c *cachingVisibilityManager) Close() {
	c.delegate.Close()
}

func (c *cachingVisibilityManager) GetReadStoreName(nsName namespace.Name) string {
	return c.delegate.GetReadStoreName(nsName)
}

func (c *cachingVisibilityManager) GetStoreNames() []string {
	return c.delegate.GetStoreNames()
}

func (c *cachingVisibilityManager) HasStoreName(stName string) bool {
	return c.delegate.HasStoreName(stName)
}

func (c *cachingVisibilityManager) GetIndexName() string {
	return c.delegate.GetIndexName()
}

func (c *cachingVisibilityManager) ValidateCustomSearchAttributes(searchAttributes map[string]any) (map[string]any, error) {
	return c.delegate.ValidateCustomSearchAttributes(searchAttributes)
}

func (c *cachingVisibilityManager) RecordWorkflowExecutionStarted(
	ctx context.Context,
	request *manager.RecordWorkflowExecutionStartedRequest,
) error {
	err := c.delegate.RecordWorkflowExecutionStarted(ctx, request)
	if err == nil {
		c.invalidateNamespace(request.NamespaceID)
	}
	return err
}

func (c *cachingVisibilityManager) RecordWorkflowExecutionClosed(
	ctx context.Context,
	request *manager.RecordWorkflowExecutionClosedRequest,
) error {
	err := c.delegate.RecordWorkflowExecutionClosed(ctx, request)
	if err == nil {
		c.invalidateNamespace(request.NamespaceID)
	}
	return err
}

func (c *cachingVisibilityManager) UpsertWorkflowExecution(
	ctx context.Context,
	request *manager.UpsertWorkflowExecutionRequest,
) error {
	err := c.delegate.UpsertWorkflowExecution(ctx, request)
	if err == nil {
		c.invalidateNamespace(request.NamespaceID)
	}
	return err
}

func (c *cachingVisibilityManager) DeleteWorkflowExecution(
	ctx context.Context,
	request *manager.VisibilityDeleteWorkflowExecutionRequest,
) error {
	err := c.delegate.DeleteWorkflowExecution(ctx, request)
	if err == nil {
		c.invalidateNamespace(request.NamespaceID)
	}
	return err
}

func (c *cachingVisibilityManager) ListWorkflowExecutions(
	ctx context.Context,
	request *manager.ListWorkflowExecutionsRequestV2,
) (*manager.ListWorkflowExecutionsResponse, error) {
	cacheKey := c.buildCacheKey("ListWorkflowExecutions", request.NamespaceID.String(), request.Query, request.PageSize, request.NextPageToken)

	if cached := c.getFromCache(cacheKey, "ListWorkflowExecutions"); cached != nil {
		if resp, ok := cached.(*manager.ListWorkflowExecutionsResponse); ok {
			return resp, nil
		}
	}

	resp, err := c.delegate.ListWorkflowExecutions(ctx, request)
	if err == nil {
		c.putInCache(cacheKey, resp, listWorkflowExecutionsTTL)
	}

	return resp, err
}

func (c *cachingVisibilityManager) CountWorkflowExecutions(
	ctx context.Context,
	request *manager.CountWorkflowExecutionsRequest,
) (*manager.CountWorkflowExecutionsResponse, error) {
	ttl := countWorkflowExecutionsTTL
	if c.isSchedulerQuery(request.Query) {
		ttl = schedulerCountTTL
	}

	cacheKey := c.buildCacheKey("CountWorkflowExecutions", request.NamespaceID.String(), request.Query, 0, nil)

	if cached := c.getFromCache(cacheKey, "CountWorkflowExecutions"); cached != nil {
		if resp, ok := cached.(*manager.CountWorkflowExecutionsResponse); ok {
			return resp, nil
		}
	}

	resp, err := c.delegate.CountWorkflowExecutions(ctx, request)
	if err == nil {
		c.putInCache(cacheKey, resp, ttl)
	}

	return resp, err
}

func (c *cachingVisibilityManager) GetWorkflowExecution(
	ctx context.Context,
	request *manager.GetWorkflowExecutionRequest,
) (*manager.GetWorkflowExecutionResponse, error) {
	return c.delegate.GetWorkflowExecution(ctx, request)
}

func (c *cachingVisibilityManager) ListChasmExecutions(
	ctx context.Context,
	request *visibilityservice.ListChasmExecutionsRequest,
) (*visibilityservice.ListChasmExecutionsResponse, error) {
	return c.delegate.ListChasmExecutions(ctx, request)
}

func (c *cachingVisibilityManager) CountChasmExecutions(
	ctx context.Context,
	request *visibilityservice.CountChasmExecutionsRequest,
) (*visibilityservice.CountChasmExecutionsResponse, error) {
	return c.delegate.CountChasmExecutions(ctx, request)
}

func (c *cachingVisibilityManager) AddSearchAttributes(
	ctx context.Context,
	request *manager.AddSearchAttributesRequest,
) error {
	return c.delegate.AddSearchAttributes(ctx, request)
}

func (c *cachingVisibilityManager) buildCacheKey(method, namespaceID, query string, pageSize int, pageToken []byte) string {
	data := fmt.Sprintf("%s:%s:%s:%d:%x", method, namespaceID, query, pageSize, pageToken)
	hash := sha256.Sum256([]byte(data))
	return hex.EncodeToString(hash[:])
}

func (c *cachingVisibilityManager) getFromCache(key, method string) any {
	c.mu.RLock()
	defer c.mu.RUnlock()

	entry, exists := c.cache[key]
	if !exists {
		if c.cacheMisses != nil {
			c.cacheMisses.Record(1, metrics.OperationTag(method))
		}
		return nil
	}

	if time.Now().After(entry.expiresAt) {
		if c.cacheMisses != nil {
			c.cacheMisses.Record(1, metrics.OperationTag(method))
		}
		return nil
	}

	if c.cacheHits != nil {
		c.cacheHits.Record(1, metrics.OperationTag(method))
	}
	return entry.value
}

func (c *cachingVisibilityManager) putInCache(key string, value any, ttl time.Duration) {
	c.mu.Lock()
	defer c.mu.Unlock()

	c.cache[key] = &cacheEntry{
		value:     value,
		expiresAt: time.Now().Add(ttl),
	}
}

func (c *cachingVisibilityManager) invalidateNamespace(namespaceID namespace.ID) {
	c.mu.Lock()
	defer c.mu.Unlock()

	nsIDStr := namespaceID.String()
	keysToDelete := make([]string, 0)

	for key := range c.cache {
		keysToDelete = append(keysToDelete, key)
	}

	for _, key := range keysToDelete {
		delete(c.cache, key)
	}

	c.logger.Debug("Invalidated visibility cache for namespace", tag.WorkflowNamespaceID(nsIDStr), tag.Counter(len(keysToDelete)))
}

func (c *cachingVisibilityManager) isSchedulerQuery(query string) bool {
	return len(query) > 0 && (query == "TemporalNamespaceDivision='TemporalScheduler' AND status=1" ||
		query == "TemporalNamespaceDivision = 'TemporalScheduler' AND status = 1")
}
